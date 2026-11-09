# CORE release history — what the changelog and git log say

Source: `/home/user/core-plugin` at commit `79b526b` (CORE 3.20.1). Written 2026-11-09.

This file is evidence for the rewrite plan. It is a record, not a plan.

## The short version

- **Growth.** 46 releases in 150 days. Shipped scripts went from 8 files to 100, and from 70 KB to 1.7 MB. The changelog has 177 "Fixed" bullets against 142 "Added".
- **The defect class.** 132 changelog entries describe something that said "fine" while it had read nothing, written nothing, run nothing, or looked in the wrong place. 27 more describe the opposite, a false alarm. 42 more sit beside the class. 17 more appear only in commit messages.
- **Share.** About two in three of all "Fixed" bullets belong to this family.
- **Top mechanisms.** A marker trusted on its word (25). The wrong place (24). A fail-open default (20).
- **Repeats.** 34 of the 132 are one fault fixed again in another copy of the same rule.
- **One symptom, several causes.** And the cure has a cost: several false alarms were made by fail-closed fixes (2.8).
- **Still there.** Five small runs on 3.20.1 show the class is alive (2.7).
- **Measurement.** The changelog never reports a retrieval score. It says no with-and-without comparison exists (5.2).

## How to read it

- `L123` means line 123 of `CHANGELOG.md`.
- A seven-character code like `5aee6df` is a git commit.
- A path with a line, like `scripts/close-pass.mjs:491`, is under `plugins/core/skills/core/` unless it starts with another folder.
- `[run]` means I ran that command in this session. The output is quoted or summed up.
- Text inside curly quotes is exact. Every changelog quote that is followed by its line number was checked by script against that line.

## What I read

- All 926 lines of `CHANGELOG.md`.
- All 699 non-merge commit subjects. The full message of about 30 commits picked by subject. I did not read every commit body. Together they run to about 500 KB.
- The current source behind the eight leads in Section 3.

## Limits

1. **The clone is shallow.** `git rev-parse --is-shallow-repository` prints `true`, with 12 cut points `[run]`. The oldest commit I can see is `41844c9` (2026-05-20). It is a merge with its parents cut off, and its manifest already says version 2.0.1. It is not the project's first commit. The changelog stops at the same place: “History prior to v2.0.1 not retroactively reconstructed.” (L926)
2. **No tags.** `git tag -l` prints nothing `[run]`. I found releases by commit subject ("Release vX.Y.Z") and by the version in the manifest.
3. **"First added in commit X" is not safe here.** Files look newly added at each cut point. I used the file tree at each release commit instead.
4. **Commits per release are not reported.** Counting between two commits gives wrong numbers in a shallow clone.
5. **One later commit is not CORE's.** `6464a1c` (2026-11-09) added `gauntlet/` during this planning run. All counts stop at `79b526b`.
6. **I did not run the test suite.** I ran five small read-only checks. Each is marked `[run]` where it is used and listed in the last appendix.

---

## 1. Growth timeline

### 1.1 Totals

- **46 releases** in the changelog (L10 to L915) `[run: grep -c '^## \[[0-9]' CHANGELOG.md]`.
- **Date range:** 2026-05-20 (2.0.1) to 2026-10-17 (3.20.1). That is 150 days, about one release every three days.
- **Releases by month:** May 19, June 9, July 9, August 0, September 5, October 4 `[run]`.
- **Two version numbers were skipped.** 2.7.0: “There is no `v2.7.0` tag; its content ships here under 2.8.0.” (L734) And 3.16.0: the changelog has no entry, and the manifest reads 3.15.1 at `6ba01fe` and 3.16.1 at `d44f8b3` `[run]`.
- **759 commits** up to `79b526b`: 699 non-merge and 60 merges, one author `[run]`. Non-merge commits by month: May 105, June 129, July 230, August 0, September 110, October 125. There are no commits between 2026-07-31 and 2026-09-06.
- **Commit subjects:** 134 start with "fix". 72 start with "feat" `[run]`.
- **Changelog bullets by heading:** Added 142, Changed 99, **Fixed 177**, Removed 20, Security 6 `[run]`. Sub-bullets are counted.
- **Rework signals in git:** 12 commits re-stamp the build label (`Re-stamp source_sha …`). 6 commits are reverts `[run]`.

### 1.2 Size at five points

Counts come from `git ls-tree -r -l <commit>` `[run]`. "Shipped" means the tree a user installs. Before 3.2.0 that was `skills/` + `hooks/` + the manifest folders. From 3.2.0 it is `plugins/core/`. Tests are not counted as shipped. A "script" is a `.mjs`, `.js` or `.sh` file. "Prose" is a `.md` file.

| Point | Commit | Shipped files | Shipped bytes | Scripts | Script bytes | Prose files | Prose bytes | Test files | Test bytes | Whole repo files | Whole repo bytes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| First visible commit (already 2.0.1) | `41844c9` | 45 | 355,736 | 8 | 69,797 | 31 | 283,661 | 0 | 0 | 51 | 386,229 |
| v2.0.2 | `d9e8c12` | 50 | 445,316 | 10 | 91,732 | 33 | 349,072 | 0 | 0 | 58 | 478,852 |
| v3.0.0 | `08cd762` | 88 | 796,427 | 40 | 346,929 | 40 | 436,161 | 46 | 265,284 | 239 | 2,000,333 |
| v3.10.0 | `02ea4b0` | 111 | 1,133,977 | 64 | 614,785 | 40 | 506,105 | 87 | 495,625 | 212 | 1,756,829 |
| v3.20.1 | `140dc45` | 148 | 2,339,830 | 100 | 1,718,923 | 40 | 606,815 | 229 | 2,364,898 | 400 | 5,023,769 |

Notes on the table:

- At v3.0.0 the repo held the plugin twice. `plugins/core/` was a mirror of `skills/` for Codex (92 more files, 855,928 bytes, plus 23 mirrored test files). That is why the whole repo was bigger at 3.0.0 than at 3.10.0. The mirror went away in 3.2.0: “The top-level `skills/`/`hooks/` trees and the rsync mirror are removed” (L646).
- The repo held no test files until 2.8.0. The changelog still reports a suite before then: “Test suite: 497 → 508” (L846), in release 2.3.2. Those tests lived somewhere else. The reported counts are not steady either: 508 at 2.3.2 (L846), then 482 at 3.5.0 (L564). So the early test numbers do not describe this repo.
- From 3.2.0 to 3.5.0 the shipped tree also held copies of the four top-level docs. They were removed in `b2485e0`. That lifts the prose numbers for those rows in 1.4.
- `HEAD` (`79b526b`) has the same files as the 3.20.1 release commit `[run: git diff --stat 140dc45 79b526b → empty]`.

### 1.3 What grew, in one paragraph

Scripts grew from 8 files to 100 (12.5 times) and from 70 KB to 1,719 KB (24.6 times). Prose barely grew in count, 31 files to 40, and doubled in bytes, 284 KB to 607 KB. Tests went from nothing in the repo to 229 files and 2,365 KB. The test code is now bigger than the plugin it tests (2,340 KB). The two biggest jumps in script bytes were 3.14.0 (+364 KB, 16 new scripts: the metrics system) and 3.20.0 (+185 KB: state moved into the project, project-only mode). The script count fell at only five releases: 3.1.0, 3.13.1, 3.15.1, 3.17.0 and 3.18.0. Each time by one or two files.

### 1.4 Size at every release

| Release | Shipped files | Scripts (files / KB) | Prose `.md` (files / KB) | Shipped KB | Test files / KB | Whole repo files / KB |
|---|---|---|---|---|---|---|
| 2.0.1 | 45 | 8 / 70 | 31 / 284 | 356 | 0 / 0 | 51 / 386 |
| 2.0.2 | 50 | 10 / 92 | 33 / 349 | 445 | 0 / 0 | 58 / 479 |
| 2.1.0 | 50 | 10 / 92 | 34 / 364 | 460 | 0 / 0 | 61 / 499 |
| 2.2.0 | 52 | 11 / 103 | 35 / 382 | 489 | 0 / 0 | 63 / 530 |
| 2.3.0 | 54 | 13 / 121 | 35 / 385 | 511 | 0 / 0 | 65 / 554 |
| 2.3.1 | 55 | 14 / 126 | 35 / 386 | 517 | 0 / 0 | 66 / 561 |
| 2.3.2 | 55 | 14 / 128 | 35 / 386 | 518 | 0 / 0 | 66 / 564 |
| 2.3.3 | 55 | 14 / 128 | 35 / 386 | 519 | 0 / 0 | 66 / 565 |
| 2.4.0 | 57 | 14 / 129 | 36 / 391 | 525 | 0 / 0 | 68 / 577 |
| 2.4.1 | 57 | 14 / 129 | 36 / 391 | 525 | 0 / 0 | 68 / 578 |
| 2.5.0 | 59 | 16 / 162 | 36 / 392 | 559 | 0 / 0 | 70 / 617 |
| 2.6.0 | 65 | 19 / 202 | 38 / 412 | 625 | 0 / 0 | 76 / 686 |
| 2.8.0 | 77 | 31 / 279 | 38 / 416 | 707 | 12 / 66 | 100 / 838 |
| 2.8.1 | 77 | 31 / 280 | 38 / 416 | 708 | 12 / 67 | 100 / 841 |
| 3.0.0 | 88 | 40 / 347 | 40 / 436 | 796 | 46 / 265 | 239 / 2,000 |
| 3.1.0 | 85 | 39 / 347 | 39 / 436 | 795 | 47 / 271 | 234 / 1,994 |
| 3.1.1 | 85 | 39 / 348 | 39 / 436 | 797 | 50 / 296 | 237 / 2,033 |
| 3.2.0 | 91 | 39 / 348 | 43 / 502 | 864 | 25 / 149 | 128 / 1,095 |
| 3.2.1 | 91 | 39 / 349 | 43 / 503 | 866 | 26 / 154 | 129 / 1,101 |
| 3.2.2 | 92 | 40 / 352 | 43 / 505 | 871 | 27 / 158 | 131 / 1,112 |
| 3.3.0 | 94 | 41 / 374 | 44 / 518 | 906 | 28 / 181 | 134 / 1,175 |
| 3.4.0 | 99 | 48 / 467 | 44 / 535 | 1,015 | 41 / 266 | 153 / 1,373 |
| 3.5.0 | 101 | 50 / 482 | 44 / 538 | 1,033 | 46 / 291 | 160 / 1,419 |
| 3.6.0 | 98 | 50 / 499 | 41 / 462 | 973 | 50 / 329 | 160 / 1,403 |
| 3.7.0 | 97 | 50 / 499 | 40 / 440 | 951 | 50 / 329 | 161 / 1,391 |
| 3.8.0 | 100 | 53 / 543 | 40 / 487 | 1,042 | 67 / 438 | 181 / 1,600 |
| 3.9.0 | 107 | 60 / 579 | 40 / 495 | 1,087 | 84 / 473 | 205 / 1,683 |
| 3.10.0 | 111 | 64 / 615 | 40 / 506 | 1,134 | 87 / 496 | 212 / 1,757 |
| 3.11.0 | 120 | 72 / 745 | 41 / 519 | 1,277 | 129 / 644 | 266 / 2,075 |
| 3.12.0 | 128 | 78 / 875 | 42 / 533 | 1,423 | 135 / 744 | 280 / 2,323 |
| 3.13.0 | 132 | 80 / 936 | 44 / 545 | 1,496 | 137 / 868 | 286 / 2,525 |
| 3.13.1 | 131 | 79 / 913 | 44 / 544 | 1,472 | 136 / 847 | 284 / 2,483 |
| 3.14.0 | 149 | 95 / 1,277 | 46 / 588 | 1,881 | 155 / 1,224 | 321 / 3,312 |
| 3.14.1 | 149 | 95 / 1,274 | 46 / 589 | 1,878 | 155 / 1,232 | 321 / 3,318 |
| 3.15.0 | 147 | 95 / 1,335 | 44 / 551 | 1,901 | 176 / 1,414 | 345 / 3,576 |
| 3.15.1 | 145 | 94 / 1,324 | 43 / 540 | 1,879 | 175 / 1,414 | 340 / 3,542 |
| 3.16.1 | 144 | 94 / 1,370 | 42 / 543 | 1,927 | 179 / 1,502 | 343 / 3,689 |
| 3.17.0 | 140 | 93 / 1,393 | 39 / 539 | 1,945 | 178 / 1,524 | 338 / 3,733 |
| 3.17.1 | 140 | 93 / 1,393 | 39 / 539 | 1,945 | 178 / 1,524 | 338 / 3,734 |
| 3.17.2 | 140 | 93 / 1,397 | 39 / 539 | 1,950 | 178 / 1,538 | 338 / 3,753 |
| 3.18.0 | 138 | 91 / 1,375 | 39 / 538 | 1,926 | 176 / 1,514 | 334 / 3,707 |
| 3.19.0 | 140 | 93 / 1,480 | 39 / 548 | 2,042 | 181 / 1,664 | 341 / 3,988 |
| 3.19.1 | 141 | 94 / 1,505 | 39 / 566 | 2,086 | 188 / 1,765 | 349 / 4,139 |
| 3.19.2 | 141 | 94 / 1,523 | 39 / 577 | 2,115 | 189 / 1,814 | 350 / 4,228 |
| 3.20.0 | 148 | 100 / 1,708 | 40 / 603 | 2,325 | 226 / 2,340 | 397 / 4,982 |
| 3.20.1 | 148 | 100 / 1,719 | 40 / 607 | 2,340 | 229 / 2,365 | 400 / 5,024 |

### 1.5 The releases

Changelog date first. The release commit and its git date follow. They differ by a day in places.

| Release | Changelog date | Commit (date) | Lines | What it added or changed |
|---|---|---|---|---|
| 2.0.1 | 2026-05-20 | `41844c9` (2026-05-20) | L915–L922 | Codex harness adapter (first cut). Marketplace path fix. |
| 2.0.2 | 2026-05-23 | `d9e8c12` (2026-05-23) | L903–L913 | Source-registration framework and `/register-sources`. Workspace fork-check. Symlink fix on CLI entry guards. |
| 2.1.0 | 2026-05-23 | `5b65cea` (2026-05-23) | L890–L901 | Cloud-sync ghost-file cleanup. CHANGELOG. Version-check CI, auto-tag, `/cut-release`. |
| 2.2.0 | 2026-05-23 | `115666a` (2026-05-23) | L876–L888 | Hot section atop PROJECT.md. `by-when` on open questions. Cluster naming doc. Push policy per user. |
| 2.3.0 | 2026-05-24 | `49e637a` (2026-05-23) | L860–L874 | `demote-moves`. Hot-section 500-token budget. `log-event.mjs` structured logs. 70 KB PROJECT.md cap. |
| 2.3.1 | 2026-05-24 | `5402a48` (2026-05-24) | L848–L858 | `generate-memory-index.mjs`. Check for source pulls that were deferred, not fetched. |
| 2.3.2 | 2026-05-24 | `a26b616` (2026-05-24) | L837–L846 | Two memory-index fixes (link paths, descriptions). |
| 2.3.3 | 2026-05-24 | `88fd002` (2026-05-24) | L832–L835 | Rename `HARD_CAP_BYTES` to `SOFT_TARGET_BYTES`. It never enforced anything. |
| 2.4.0 | 2026-05-25 | `826c8f3` (2026-05-24) | L809–L830 | Gemini adapter (draft, unverified). Manifest lockstep in CI. Four bug fixes. |
| 2.4.1 | 2026-05-26 | `018fd4d` (2026-05-25) | L804–L807 | Prose rule: view memory before composing the readiness summary. |
| 2.5.0 | 2026-05-27 | `cd3a2a0` (2026-05-27) | L783–L802 | Metrics storage scaffold with Windows OneDrive redirect. OTel-format dual-write. `demote-state-narrative`. |
| 2.6.0 | 2026-05-27 | `e8baf77` (2026-05-28) | L762–L781 | Capability probes and harness descriptor. `resolve-plugin-root`. Five doctrines. Probe wired into startup. |
| 2.8.0 | 2026-05-29 | `19a5158` (2026-05-29) | L732–L760 | Capability history and drift. Visibility canary. Five new probes, one unwired. `read-transcript` (unwired). Adversarial-run gate. |
| 2.8.1 | 2026-05-29 | `f237e53` (2026-05-29) | L721–L730 | Canary fix: visible line, not an HTML comment. |
| 3.0.0 | 2026-05-30 | `08cd762` (2026-05-30) | L677–L719 | CONTRACT.md generates CLAUDE.md / AGENTS.md / GEMINI.md. Retrieval-event producer. Codex marketplace tree. Validation fixes. |
| 3.1.0 | 2026-05-31 | `8e9c615` (2026-05-31) | L661–L675 | `CORE_ROOT` resolver hardened. Cross-project write guard. Gemini removed. |
| 3.1.1 | 2026-05-31 | `82e4918` (2026-05-31) | L649–L659 | Two Windows resolver fixes. |
| 3.2.0 | 2026-05-31 | `b6cb2e5` (2026-05-31) | L638–L647 | `plugins/core/` becomes the one tree. `/orient` records retrieval events. |
| 3.2.1 | 2026-05-31 | `64a8236` (2026-05-31) | L631–L636 | Fork-check stops re-forking every startup. |
| 3.2.2 | 2026-06-01 | `fcf700a` (2026-06-01) | L620–L629 | Slug fix for dotted usernames. Three validator false positives. |
| 3.3.0 | 2026-06-01 | `acad3a3` (2026-06-01) | L602–L618 | `/configure-project`. Two-tier capability reporting. Adversarial-run gate wired into analysis. |
| 3.4.0 | 2026-06-02 | `af7e75e` (2026-06-02) | L577–L600 | Recognition classifier, daily rollup, detectors, calibration harness. Validity dates on units. Orphan detector. |
| 3.5.0 | 2026-06-02 | `98d50bb` (2026-06-02) | L562–L575 | Hardening pass over all 48 scripts: atomic writes, fail-closed gates, classifier honesty. |
| 3.6.0 | 2026-06-07 | `c45c66b` (2026-06-06) | L538–L560 | `/orient` deprecated. Metrics capture on by default. Loud diagnostics. |
| 3.7.0 | 2026-06-07 | `810c02f` (2026-06-07) | L523–L536 | USAGE.md, llms.txt, README rewrite. `/organize-files` removed. |
| 3.8.0 | 2026-06-28 | `f12a0cf` (2026-06-28) | L499–L521 | Audit remediation (111 findings). `premise` unit type. CI on Linux and Windows. 24 Windows bugs. |
| 3.9.0 | 2026-06-28 | `aa718fc` (2026-06-28) | L480–L497 | Per-turn retrieval hook, on by default. `maintenance-run`. Summary index. Context-integrity marker. |
| 3.10.0 | 2026-06-30 | `02ea4b0` (2026-06-30) | L453–L478 | SessionStart hook runs `/core`. SessionEnd hook runs a background close. Hooks log. |
| 3.11.0 | 2026-07-15 | `71ba3bc` (2026-07-15) | L425–L451 | Shared-write locks. `buildFinalContextPack`. Snapshots. Strict evaluator. BM25 body search. Recursive index. Recall@K harness. Package smoke. |
| 3.12.0 | 2026-07-18 | `95783b2` (2026-07-18) | L410–L423 | Reasoning-tier retrieval. `source_sha` build stamp. Outcome-tracking core. Env-var redirect fix. |
| 3.13.0 | 2026-07-21 | `d1f47de` (2026-07-21) | L383–L408 | `/export-obsidian` (wikilinks written into unit files). Mailbox nudge. Audit fixes. Three scripts removed. |
| 3.13.1 | 2026-07-22 | `422d0fa` (2026-07-21) | L375–L381 | Stale `source_sha` fix. Flaky test rebuilt. |
| 3.14.0 | 2026-07-24 | `4e6aa14` (2026-07-24) | L323–L373 | Turn capture. Scorecards. Hindsight judge. Tripwires. `/self-test`. `/metrics` as one door. `/memory-view`. Startup decoration backstop. |
| 3.14.1 | 2026-07-24 | `2a18fec` (2026-07-24) | L316–L321 | Dev-process scrub: about 710 references across about 190 files. |
| 3.15.0 | 2026-07-29 | `c8b2aeb` (2026-07-29) | L285–L314 | Bounded `/finalize`. Exact-session close receipts. Memory back-fill. Release-identity gate. Prose evals. Spawn-close and mailbox removed. |
| 3.15.1 | 2026-07-29 | `f0e63c8` (2026-07-29) | L268–L283 | Hook-log fallback for sandboxes. CI quoting fix. More narrative cleanup. |
| 3.16.1 | 2026-07-31 | `d44f8b3` (2026-07-31) | L238–L266 | `/memory-view` live page. One shared CLI entry helper. Dead subsystems removed. |
| 3.17.0 | 2026-09-14 | `6b1ed1e` (2026-09-14) | L189–L236 | Reasoning escalation in the retrieval hook. `/orient` and `/vibecheck` removed. Generators merged. Auto-memory path fix. |
| 3.17.1 | 2026-09-14 | `8ac4707` (2026-09-14) | L184–L187 | Build-stamp fix. |
| 3.17.2 | 2026-09-19 | `6f592fa` (2026-09-19) | L175–L182 | Ranking sees dated subfolders. Exclusion reasons reported. |
| 3.18.0 | 2026-09-23 | `995e409` (2026-09-23) | L161–L173 | Agent decides memory writes; A/B/C modes gone. Canary removed. |
| 3.19.0 | 2026-09-29 | `3caa2a0` (2026-09-28) | L121–L159 | Project state moves into the project (`.core/`). Transcript-based memory-visibility check. Scheduled deletion stops. |
| 3.19.1 | 2026-10-02 | `ff1d339` (2026-10-02) | L73–L119 | Security, privacy and honesty fixes after the move. |
| 3.19.2 | 2026-10-04 | `711e939` (2026-10-04) | L54–L71 | Close receipts bound to session and project. Purge and history hardening. |
| 3.20.0 | 2026-10-09 | `20a44ad` (2026-10-08) | L29–L52 | State folder renamed `_core`. Agent notes per project. Project-only mode. |
| 3.20.1 | 2026-10-17 | `140dc45` (2026-10-17) | L10–L27 | Stamp, custody and receipt fixes. Plain-words rules. |

---

## 2. The "reports success while doing nothing" defect class

### 2.1 What I counted, and the rules

**In the count.** A changelog entry goes in when the bug was this: an instrument, check, probe, hook, receipt, marker, metric or test said success, clean, closed, zero, PASS or exit 0, while it had read nothing, written nothing, run nothing, or looked in the wrong place.

**Also in the count, kept apart.** The inverse: it said failed, owed, pending, degraded or unknown, and that was not real.

**Counted apart as "adjacent".** Three kinds of entry sit next to the class but are not in it. Instruments nobody read. Words that promised more than the code did. And the mirror case, where the report said nothing happened and something did.

**How rows are cut.** One row per distinct defect. A changelog bullet that names four defects gives four rows. Two bullets about one defect give one row.

**How I grouped.** One group per row, by the mechanism the changelog names. Many rows could sit in two groups. A wrong path often ends as an empty read. I filed by root cause where the entry gives one, and by symptom where it does not.

**What the number means.** It is a floor. The changelog does not list every fix. Section 2.6 lists 17 more that appear only in commit messages.

**Share of all fixes.** The rows in the main count use 140 distinct changelog lines. 114 of those sit under a "Fixed" heading. The changelog has 177 "Fixed" bullets in all `[run]`. So about two in three of all "Fixed" bullets describe this family.

### 2.2 The count

| Mechanism | Entries |
|---|---|
| T. Stale or unverified marker trusted | 25 |
| W. Wrong place | 24 |
| F. Fail-open default | 20 |
| Z. Unreadable, missing, or empty read as zero / clean / absent / complete | 17 |
| S. Error swallowed or result discarded | 17 |
| M. Metric or verdict counted the wrong thing | 13 |
| X. Ran nothing, said fine | 8 |
| G. Test or CI gate that could not fail, or did not run | 8 |
| I. Inverse: false failure, false "owed", false alarm | 27 |
| **Reported fine when it was not (all rows but I)** | **132** |
| **Inverse (I)** | **27** |
| **Both together** | **159** |

Counted apart, because nothing false was reported or because the fault was in words:

| Adjacent group | Entries |
|---|---|
| D. Instruments with no reader, no producer, or that could not fire | 16 |
| C. Words that claimed more than the code did | 23 |
| O. Said "off" or "refused", wrote anyway | 3 |
| **Adjacent total** | **42** |

Where they sit, by the release that fixed them:

| Release | Reported-fine entries | Inverse entries |
|---|---|---|
| 3.20.1 | 3 | 2 |
| 3.20.0 | 2 | 0 |
| 3.19.2 | 10 | 1 |
| 3.19.1 | 13 | 2 |
| 3.19.0 | 14 | 0 |
| 3.18.0 | 1 | 0 |
| 3.17.2 | 3 | 0 |
| 3.17.1 | 1 | 0 |
| 3.17.0 | 1 | 1 |
| 3.16.1 | 3 | 1 |
| 3.15.1 | 2 | 1 |
| 3.15.0 | 5 | 1 |
| 3.14.0 | 14 | 0 |
| 3.13.1 | 1 | 1 |
| 3.13.0 | 10 | 1 |
| 3.11.0 | 8 | 0 |
| 3.10.0 | 2 | 0 |
| 3.9.0 | 3 | 0 |
| 3.8.0 | 4 | 0 |
| 3.6.0 | 8 | 1 |
| 3.5.0 | 6 | 2 |
| 3.4.0 | 1 | 0 |
| 3.3.0 | 0 | 1 |
| 3.2.2 | 1 | 5 |
| 3.2.1 | 0 | 1 |
| 3.2.0 | 1 | 0 |
| 3.1.1 | 0 | 2 |
| 3.1.0 | 2 | 1 |
| 3.0.0 | 5 | 2 |
| 2.8.1 | 1 | 0 |
| 2.8.0 | 1 | 0 |
| 2.4.0 | 2 | 0 |
| 2.3.2 | 1 | 0 |
| 2.3.1 | 1 | 1 |
| 2.1.0 | 1 | 0 |
| 2.0.2 | 1 | 0 |

36 of the 46 releases carry at least one row. Five releases hold 61 of the 132 reported-fine rows: 3.19.0 (14), 3.14.0 (14), 3.19.1 (13), 3.19.2 (10), 3.13.0 (10). Each sits in or just after a large change: an independent audit (3.13.0), the metrics system (3.14.0), and the move of state into the project (3.19.0 to 3.19.2).

### 2.3 The entries, by mechanism

#### T. Stale or unverified marker trusted — 25

A receipt, stamp, lock, cache, or build label was taken at its word. Nothing checked that it still described the work.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| T1 | 3.20.1 | L21 | “an edit that lands between a write and its stamp reads as the user's” | A stamp adopted whatever bytes were on disk, so it could vouch for bytes the writer never wrote. | Writers stamp only the bytes they wrote. |
| T2 | 3.19.2 | L58 | “A receipt filed under a session's name used to suppress that session's close on its status alone.” | The file name and a status word were enough. The payload could name another session, or nothing. | A receipt must name its session and project and carry its record. Otherwise it is corrupt and the close stays owed. |
| T3 | 3.19.2 | L59 | “A fabricated record could then read as proof that startup had already run this session” | Adoption re-signed any parseable bootstrap record under this install's key. | Completion evidence from another install is never carried. |
| T4 | 3.19.2 | L62 | “A partial or malformed close record no longer counts as a finished close.” | A status label was accepted without the record behind it. | `recorded` needs a full-coverage inner record; `closed` needs a harness and a time. |
| T5 | 3.19.2 | L63 | “A manual close counts only the work recorded for the same session.” | Certify accepted an op record begun for another session. | Refuse with `MARKER-SESSION-MISMATCH`. |
| T6 | 3.19.1 | L96 | “A stale lock left by a named owner no longer blocks the startup catch-up.” | A dead owner's lock read as a live close. Catch-up skipped. | Stale lock no longer blocks. |
| T7 | 3.19.1 | L99 | “A store changed after the last close owes its maintenance again.” | The close marker said closed. The store had changed since. | Begin, finish and detect carry the store's signature. |
| T8 | 3.19.0 | L145 | “data in a workspace registered afterwards was marked migrated without being copied” | A finished receipt made every later run assume nothing was new. | Copy first, then mark. |
| T9 | 3.19.0 | L157 | “no longer trusts a receipt's word” | An unsigned or copied-in migration receipt let the migration skip its copy. | Receipts are signed by the install; a bad one is refused with reasons. |
| T10 | 3.17.1 | L187 | “v3.17.0 shipped carrying the v3.16.1 stamp” | The bump script set versions only. The freshness check ran on one path. Every metrics row named a commit 70 files behind. | Stamp before the release commit; check freshness on every cut. |
| T11 | 3.14.0 | L350 | “can never again go unnoticed for weeks” | The close ledger tracked only listed ops. `decorate-graph` was not on the list, so nothing was ever owed for it. | Run decoration and index refresh every startup, whatever the ledger says. |
| T12 | 3.14.0 | L358 | “precise but false provenance” | The page was stamped with the release manifest's old commit id, not the tree it ran from. | Use the real `git rev-parse HEAD`; fail closed if neither source works. |
| T13 | 3.14.0 | L359 | “a declined candidate and a real publish used to leave the same kind of record” | The receipt was written before consent, so it could not say what happened next. | A separate publish receipt for every outcome. |
| T14 | 3.14.0 | L364 | “The fresh stamp made that divergence permanently undetectable” | Two writers stamped a fresh baseline over the whole file, over a user edit nobody had reconciled. | Classify before writing; refuse and report `needs_reconciliation`. |
| T15 | 3.13.1 | L378 | “the tagged artifact carried a `source_sha` 33 commits stale” | The build label was stamped at version-bump time and never re-stamped. | Corrected to the packaged commit. |
| T16 | 3.13.0 | L392 | “a cache staleness check was byte-only, so a unit past its own expiration date could keep serving from a stale cache” | The freshness check compared bytes, not dates. | Structural check, with a regression test. |
| T17 | 3.13.0 | L394 | “no longer trusts a cache stamp that couldn't distinguish” | One stamp covered the whole file, so a user edit and a hot-block refresh looked the same. | Hash the user's region apart from the generated block. |
| T18 | 3.13.0 | L395 | “no longer certifies a session closed when the LLM half of close recorded zero judgment ops” | Closed was stamped without checking that any close work was recorded. | Require the ops before certifying. |
| T19 | 3.11.0 | L442 | “timestamp equality no longer certifies content equality” | The freshness signature hashed paths and times. A rewritten file with its old time kept ranking. | Content-derived signature; validate every cached record. |
| T20 | 3.11.0 | L446 | “accepted any parseable cached index, so a retired unit could keep ranking” | Two read paths skipped the cache check. | All readers go through the validating loader; a guard test enrolls each reader. |
| T21 | 3.10.0 | L475 | “so closes can't silently stop happening” | A lock left by a killed process stayed "held" forever if its PID was reused. | Hard age ceiling; lock and marker writes coupled. |
| T22 | 3.9.0 | L492 | “a retired or deleted unit no longer lingers in retrieval results” | The summary index did not notice its sources had changed. | Regenerate on a set-diff signature. |
| T23 | 2.4.0 | L819 | “bumped from stale `2.0.1-dev.20260521.5` to `2.4.0`” | One manifest's version sat four releases behind. | Lockstep bump, CI check. |
| T24 | 2.3.1 | L851 | “sentinel content references found during external-source sweeps but not actually fetched” | A placeholder stood in memory where fetched content should be. | `/process-memory` Step 0 looks for the pattern. |
| T25 | 2.1.0 | L901 | “removed as a redundant (and stale) source” | A second version file had gone stale. | One version source. |

#### W. Wrong place — 24

It looked in, wrote to, or was wired to the wrong path, folder, key, session or trigger. The read came back empty or stale, and the result was reported as real.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| W1 | 3.19.2 | L60 | “the notice named whichever folder the pin said” | After an upgrade, captured turns went to the project folder, then back to AppData. The notice followed the pin, not the rows. | Every new row goes to `<project>/_metrics/`. An older outside folder is read-only history, reported apart. |
| W2 | 3.19.2 | L64 | “registering a project, unregistering it, or a root that turns read-only no longer hides them” | History and purge looked in one state location. A change of registration hid the older records. | Read the project folder and the machine-local folder, for every harness. |
| W3 | 3.19.1 | L93 | “The memory-visibility and memory-accessed checks then reported PASS or DEGRADED from another session's evidence.” | The asked session had no transcript, so the reader fell back to the newest transcript in the project. | Every consumer treats a session mismatch as UNKNOWN. |
| W4 | 3.19.1 | L106 | “Project slugs map underscores to hyphens, as Claude Code does on disk.” | CORE's path-to-folder rule differed from the harness's for names with `_`. It looked in a folder that did not exist. | Map `_` to `-`. |
| W5 | 3.19.1 | L110 | “`configure-project` passes the harness to startup under the key startup reads.” | The value was passed under a key the reader ignores. | Use the reader's key. |
| W6 | 3.19.0 | L136 | “purge and stats would silently switch to the project-local folder — empty, since the real data was elsewhere — and report a clean result” | A half-lost pin looked the same as never having a pin. Tools read the default folder, which was empty. | Half a pin is invalid. A marker outside the pin folder catches a total loss. |
| W7 | 3.19.0 | L138 | “Purge and stats no longer report a clean result for the wrong folder.” | The pin stopped verifying, the fallback folder held nothing, and the tools reported zero rows or a finished purge. | Answer `pin-unverified` and delete nothing. |
| W8 | 3.19.0 | L149 | “one project's captured turns could be routed into the other's `_metrics/`” | The folder name for `a.b` and `a-b` was the same. | Name = readable slug plus a hash of the full path. |
| W9 | 3.19.0 | L155 | “looked like a project whose folder no longer exists and its state was never migrated” | The migrator read only `path`. Older entries spelled it `project_path`. | Read both spellings. |
| W10 | 3.19.0 | L158 | “the store could read clean while a writer was holding files there” | The edit check listed only the top level of `_memories/`. | Walk the store the way ranking does. Report an unlistable folder as `read-only`. |
| W11 | 3.17.2 | L178 | “the directory walk read only the store's top level” | Ranking, the memory index and hot-section candidates never saw dated subfolders. About 4 in 10 units on one store. | Recursive walk. |
| W12 | 3.17.0 | L233 | “a 30 KB orphan MEMORY.md nobody read” | Memory scripts keyed the harness folder on the working folder. Claude Code keys it on the git root. They wrote to and measured a folder the harness never injects. | `resolveMemoryProjectRoot` keys on the worktree root. |
| W13 | 3.15.0 | L314 | “It ran only on the brand-new-workspace scaffold” | The privacy notice was wired to one startup path. Projects that already existed never saw it. | Runs at every session start, shows once, versioned. |
| W14 | 3.14.0 | L356 | “writing the current turn's content under a `corrective-retry` label mislabeled the wrong retrieval” | Evidence was filed against the wrong retrieval. | Capture is bound to the current retrieval only. |
| W15 | 3.14.0 | L366 | “every user's plugin install was probing connectivity to one particular person's private git repo by default” | A personal path shipped inside the shared probe descriptor. | Ships unconfigured. Per-install env vars. Reports "not applicable" when unset. |
| W16 | 3.13.0 | L393 | “two capability probes were mis-mapping a Windows drive-colon path to the wrong memory location” | The path-to-folder rule was wrong on Windows. | Mapping corrected; confirmed on a real Windows install. |
| W17 | 3.13.0 | L397 | “only recognized `status: archived`, missing the canonical shape” | The check read the wrong field, so archived units left in the active store passed. | Recognize the canonical shape; check the parent folder only. |
| W18 | 3.11.0 | L436 | “previously ~42% of CORE's memory files were invisible to retrieval” | The index walk skipped nested folders. | Recursive index that carries each file's real path. |
| W19 | 3.8.0 | L507 | “a `retired` unit now demotes instead of slipping through the status checks” | Each script kept its own copy of the status list. The copies drifted. | One shared vocabulary module. |
| W20 | 3.8.0 | L518 | “file mtime is demoted to a label, so a concurrently-written transcript can't be misattributed” | Metrics picked the newest transcript by file time. | Resolve the transcript by session id. |
| W21 | 3.6.0 | L555 | “(the flags previously collapsed to integrity-only)” | The closing unit check ran one of its two passes. | Run both. |
| W22 | 3.2.2 | L625 | “that never matched Claude Code's real projects folder” | The slug rule replaced `/` but not `.`. A dotted username mapped to a folder that does not exist. | One shared `mapProjectPathToSlug()`. |
| W23 | 3.1.0 | L667 | “pairing one project's units with another's MEMORY.md silently overwrote the target” | Source and target were separate arguments. Nothing checked they belonged to one project. | Refuse on mismatch. |
| W24 | 2.8.1 | L726 | “did not reach injected memory” | The probe's canary was written as an HTML comment. Claude Code strips those. The check could never pass. | Write a visible line. |

#### F. Fail-open default — 20

The gate passed, the switch flipped on, or bad input was accepted, when the code could not prove the condition.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| F1 | 3.20.0 | L51 | “An opt-out file that can't be read keeps capture off” | An unreadable opt-out used to switch capture back on. | Unreadable keeps it off. |
| F2 | 3.19.2 | L71 | “a file with no baseline is refused rather than assumed to be CORE's” | No baseline was read as "CORE wrote it". | Refuse. |
| F3 | 3.19.1 | L105 | “opt-out survives an unverified manifest being set aside” | Setting the manifest aside dropped the opt-out with it. | Opt-out survives. |
| F4 | 3.19.0 | L140 | “an unsigned or tampered pin fell back to the project's own `_metrics/`” | A bad pin fell back to the folder the redirect existed to avoid, and capture resumed there. | Capture stays off until a fresh signed pin exists. |
| F5 | 3.19.0 | L150 | “A project-root `turn_capture: false` still turns turn capture off.” | Once a signed manifest held the setting, the project-root off switch risked being ignored (implied by the fix). | It can always switch capture off. |
| F6 | 3.19.0 | L151 | “so turn capture came back on” | Adoption carried one opt-out and dropped the other. | Both survive. |
| F7 | 3.16.1 | L259 | “rejects partially-parsed” | A flag value like a number with trailing junk was accepted. | Whole-token validation on every flag. |
| F8 | 3.15.1 | L282 | “can be allowlisted without hiding an unrelated” | A guard exemption covered a whole file and pattern, so it could hide a real leak in the same file. | Exemptions match exact tokens. |
| F9 | 3.14.0 | L347 | “closing the gap between the skill prose and the CLI contract” | The consent rule lived in prose. The CLI recorded a publish without it. | The CLI refuses without `--consent-by` and `--consent-mechanism`. |
| F10 | 3.13.0 | L392 | “the aggregate-receipt privacy scanner had two path-refusal bypasses” | The refusal scan could be walked around. | Bypasses closed, with tests. |
| F11 | 3.13.0 | L396 | “fails closed instead of silently proceeding when gitignore leak-protection genuinely can't be established” | It went ahead when it could not confirm its files were ignored. | Fail closed. |
| F12 | 3.6.0 | L559 | “a non-finite `--since-days` no longer selects every event” | A bad number fell through to "everything". | Reject it. |
| F13 | 3.6.0 | L559 | “Malformed dates no longer fall through to a demote” | A date that did not parse fell through to the destructive branch. | Guarded. |
| F14 | 3.5.0 | L567 | “no longer reports AUTHORIZED when the operation-scoped mutation gate was actually denied” | The outer gate said yes while the inner gate said no. | Fail-closed mutation. |
| F15 | 3.5.0 | L567 | “degrades when it can't prove write access instead of silently passing” | The probe passed when it could not prove the thing it checks. | Report DEGRADED. |
| F16 | 3.5.0 | L569 | “can no longer clear while whole recognition states sit unmeasured” | The precision gate could clear with whole classes unmeasured. | Every state present in the labels must be measured. |
| F17 | 3.5.0 | L573 | “injected memory text no longer false-passes it” | The probe searched the transcript for a token that CORE itself had written into memory. | Only an echo by the agent counts. |
| F18 | 3.5.0 | L575 | “refuses cleanly instead of silently thinning or crashing MEMORY.md” | A bad `--top` value was used anyway. | Refuse. |
| F19 | 3.0.0 | L708 | “real units mentioning the phrase still validate” | A validator exemption matched by phrase, so real units that used the phrase were skipped. | Exempt one generated file only. |
| F20 | 3.0.0 | L713 | “a forbidden hit now fails the run rather than silently passing” | Validation never looked for units that should not appear. | Scan the top 5 for forbidden hits; fail on one. |

#### Z. Unreadable, missing, or empty read as zero / clean / absent / complete — 17

A failed or empty read became a value. Zero rows, no history, healthy store.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| Z1 | 3.20.1 | L21 | “a read-back that fails is refused rather than stamped as empty” | A failed read of the file was treated as the empty string and stamped. | Refuse as unreadable-after-write. |
| Z2 | 3.20.0 | L50 | “Calibration that can't be read is shown as unavailable, with its reason, rather than as a measured zero.” | Unreadable calibration displayed as 0. | Show "unavailable" with the reason. |
| Z3 | 3.19.2 | L60 | “A malformed registry or a state folder that can't be listed is reported as unknown rather than read as no history.” | Could not list = nothing there. | Report unknown; the purge says it is not complete. |
| Z4 | 3.19.2 | L64 | “is reported as unknown rather than read as absent, so the purge doesn't call itself complete over it” | Permission denied = absent. | Report unknown. |
| Z5 | 3.19.2 | L66 | “a file CORE can't read holds the adoption instead of completing it” | A read error let the adoption finish. | Hold the adoption. |
| Z6 | 3.19.1 | L95 | “A young lock that can't be read has an unknown owner” | An unreadable lock was treated as having no owner, and released. | Refuse; the lock survives. |
| Z7 | 3.19.1 | L100 | “the partial index replaced the complete cache, and retrieval health stayed clean” | An unreadable unit dropped out of the index without a trace. | Errors reach the index, the health report and the context pack. A complete cache is never replaced by a partial one. |
| Z8 | 3.18.0 | L173 | “silently emptied the list” | The parser read each flush-left list item as a new key. | A `- ` line continues the open list at any indent. |
| Z9 | 3.17.2 | L182 | “so a broken scan now looks different from a genuinely empty or small store” | Ranking printed one total. Units that could not be read were just missing from it. | Report why units were left out, and an incompleteness note. |
| Z10 | 3.15.0 | L311 | “an idle recorder read as a healthy one” | Every check on the recorder needed the recorder to be running. Cumulative totals hid present silence. | Count per window; add coverage and staleness checks. |
| Z11 | 3.9.0 | L488 | “reads PROJECT.md whole instead of a head slice” | The agent worked from a truncated read without knowing it. | Context-integrity marker; full read. |
| Z12 | 3.8.0 | L520 | “instead of silently falling to the no-sources default” | A one-value `sources:` field scored as no sources. | Coerce to a one-item list; warn. |
| Z13 | 3.6.0 | L556 | “so Windows/OneDrive-authored units get stamped” | CRLF line endings made the stamp skip the file. | CRLF-tolerant. |
| Z14 | 3.6.0 | L559 | “Codex array-form transcript events parse” | One real transcript shape parsed to nothing. | Parse it. |
| Z15 | 3.2.0 | L643 | “measures real retrievals instead of empty telemetry” | The most common retrieval path wrote no row, so the quality analyzer read an empty log. | `/orient` emits one row per load. |
| Z16 | 2.4.0 | L828 | “(which were never written)” | The report counted a field no writer ever set: "Sessions analyzed: 0 \| Events: 2". | Count dates from timestamps; rename the label. |
| Z17 | 2.3.2 | L841 | “produced `(description pending)` for every unit” | The index looked complete and held a placeholder on every row. | Fall back through `description:` and the first body line. |

#### S. Error swallowed or result discarded — 17

The failure happened and was caught, skipped, or never looked at. The caller saw success.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| S1 | 3.19.1 | L102 | “A failed append to the classified turn log is reported.” | A write failure was not returned. | Return `WRITE_FAILED` with the count written; exit 1. |
| S2 | 3.19.1 | L104 | “A refused state-cache stamp no longer reports success.” | The stamp was refused and the caller was told it landed. | Report the refusal. |
| S3 | 3.19.0 | L137 | “A failure writing the marker used to be silently swallowed, so a scaffold could report success” | A best-effort side write failed quietly. | The marker is part of success; roll the pin back on failure. |
| S4 | 3.19.0 | L156 | “An unreadable folder inside the old workspace used to be skipped silently, so a migration could sign off as complete with files missing” | Unreadable folders were skipped. | Stop with `legacy-held` naming the path. |
| S5 | 3.19.0 | L157 | “Startup no longer discards a failed migration or drift check” | Startup threw the failure away. | Print a marker and say so. |
| S6 | 3.17.2 | L179 | “is now recorded as skipped rather than silently vanishing from the count” | Links inside the store were dropped without a count. | Record them as skipped. |
| S7 | 3.15.0 | L311 | “becomes visible instead of recording nothing at all” | A row rejected for a missing field left no trace. | A rejected row counts as a failed attempt. |
| S8 | 3.14.0 | L356 | “never raw content, never silent” | A failed capture returned `{captured:false}` and nobody looked. | The outcome rides the hook's receipt as a status code. |
| S9 | 3.13.0 | L392 | “a lock-release failure could go completely unsurfaced” | The release error was dropped. | Surfaced, with a regression test. |
| S10 | 3.13.0 | L393 | “`/metrics-package` could silently ship a corrupt zip on a GNU-tar box with no warning” | The archive tool's result was not checked. | Fixed; confirmed on a real Windows install. |
| S11 | 3.13.0 | L393 | “`retrieve-context --query` swallowed an unrecognized flag as the query instead of failing loud” | An unknown flag was used as the search text. | Fail loud. |
| S12 | 3.11.0 | L443 | “a nested observation can no longer silently shadow a canonical unit out of the index” | A duplicate id overwrote the real unit without a word. | Canonical wins; every conflict is recorded; the CLI exits non-zero. |
| S13 | 3.11.0 | L444 | “body-search failure degrades to title-only with a visible health signal” | Body search failed and retrieval quietly got worse. | Stderr line plus `storeHealth()`. |
| S14 | 3.10.0 | L474 | “instead of the marker falsely claiming a completed close” | The background close's exit status was never read. A failed, killed or missing run was stamped closed. | Capture the exit status; mark `failed`; next startup retries. |
| S15 | 3.6.0 | L557 | “Diagnostics fail loudly instead of producing wrong-but-plausible output” | Four diagnostics printed believable wrong answers on bad input or unreadable paths. | Fail loudly. |
| S16 | 3.1.0 | L666 | “dying silently” | A syntax error the `try/catch` could not catch left `CORE_ROOT` empty. Every script call then ran against the wrong root. | Gate every call on the scripts folder; surface an unresolved root in the readiness receipt. |
| S17 | 2.8.0 | L751 | “a probe that crashes reports UNKNOWN with a probe-error reason instead of failing silently” | A crashed probe produced no row. | UNKNOWN row with the reason. |

#### M. Metric or verdict counted the wrong thing — 13

The number was real but it measured something else: mixed instruments, double counts, self-grading, a tiny sample, the wrong unit.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| M1 | 3.15.0 | L312 | “a handful of turns can read 100% and mean nothing” | A verdict was shown on a tiny sample. | Under 20 graded turns, show the sample size, not a verdict. |
| M2 | 3.14.0 | L353 | “even though neither had real proof” | One verdict line covered retrieval quality and user benefit, which nothing measured. | Three evidence classes, each labelled. |
| M3 | 3.14.0 | L357 | “could report `calibrated: true` while its numbers silently summed both instruments' judgments” | Rows from old and new classifier versions were added together. 55 of 147 rows on the live store. | One instrument cohort; the rest reported as a coverage gap. |
| M4 | 3.14.0 | L357 | “instead of by file-read order” | Conflicting rows were settled by whichever file was read first. | Deterministic rule; both-orders tests. |
| M5 | 3.14.0 | L363 | “rollup and package counts silently inflated” | A session processed twice was counted twice. 166 rows for 147 turns. | Dedupe at read time by replay identity. |
| M6 | 3.11.0 | L429 | “never a pre-cap selection” | The harness scored a selection made before the byte cap, not what the agent received (implied by the fix). | Score the delivered pack. |
| M7 | 3.11.0 | L447 | “self-graded at the wrong instant” | The example stamped "useful" at retrieval time, before anyone could know. | Usefulness is recorded later, apart. |
| M8 | 3.9.0 | L497 | “over-fire regression guard” | The in-context proxy had fired too often (implied by the guard). | Versioned proxy with a guard test. |
| M9 | 3.6.0 | L558 | “a same-day re-run no longer double-counts turns toward the precision gate” | Re-running the worksheet moved the gate. | Idempotent. |
| M10 | 3.5.0 | L568 | “a short term that was merely a substring of your large PROJECT.md no longer counts as” | A substring match counted as recognition. | Word-boundary match. |
| M11 | 3.0.0 | L694 | “line-count check replaced with byte check” | The probe measured lines. The harness cuts by bytes (~24.4KB). | Byte check. |
| M12 | 3.0.0 | L707 | “stops counting telemetry rows as retrieval proof” | Any log row counted as proof of retrieval. | Count only retrieval-shaped rows; show the split. |
| M13 | 3.0.0 | L712 | “rewarding units that mentioned the term” | The simulator dropped the word `no` and rewarded the units it should have excluded. | Treat `no <term>` as an exclusion. |

#### X. Ran nothing, said fine — 8

The script decided it was not the entry point, or hit a refusal, and exited 0. Or a status said ON while nothing could run.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| X1 | 3.20.1 | L24 | “an import failure leaves a receipt instead of a silent exit 0” | On Codex a broken shared module exited 0 with nothing recorded. | Receipt to the project hook log, or stderr. |
| X2 | 3.19.0 | L154 | “A migration that cannot finish is no longer reported as a clean run.” | A held or blocked migration exited 0. | Exit 3 for four named states; startup names each. |
| X3 | 3.16.1 | L251 | “longer exit 0 and read as success” | A refusal at a script's entry guard exited 0. | One shared entry helper that fails loudly, with a regression test. |
| X4 | 3.14.0 | L356 | “instead of a bare "ON" while capture is impossible” | Status showed the flag, not whether capture could run. | Report effective state. |
| X5 | 3.14.0 | L362 | “concluded it wasn't the entrypoint, and exited 0 having done nothing” | The entry check compared a real path to a symlinked spelling. | Compare real paths on both sides. |
| X6 | 3.6.0 | L554 | “so they run instead of silently no-opping on symlinked installs” | Same entry-guard bug in three more scripts. | Canonicalize both sides. |
| X7 | 3.4.0 | L596 | “`generate-memory-index` Windows no-op” | The entry check used a URL path that never equals a Windows path. | `fileURLToPath`. |
| X8 | 2.0.2 | L912 | “Symlink resolution on CLI entry guards (realpathSync across all 10 scripts)” | First fix of the entry-guard bug. Commit c5b21ac: "Scripts silently no-op as CLI". | `realpathSync` on both sides in 10 scripts. |

#### G. Test or CI gate that could not fail, or did not run — 8

Green meant nothing: tests skipped, a fixture that could not show the bug, an assertion swallowed, a CI leg that never ran clean.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| G1 | 3.19.1 | L112 | “has a test that fails when the session-mismatch argument is removed” | No test could tell the guard was gone. | A test that fails without it. |
| G2 | 3.19.1 | L116 | “run on Windows through a junction instead of skipping” | The refusal tests skipped on Windows. | Run them through a junction. |
| G3 | 3.19.1 | L119 | “the torn-row test no longer swallows its own assertion” | A test caught its own failure. | Tests fail under the failures they name. |
| G4 | 3.16.1 | L252 | “refuses to run gated tests instead of silently skipping them” | A dirty tree skipped gated tests and stayed green. | Refuse to run. |
| G5 | 3.15.1 | L275 | “exit 126 on every run” | Two apostrophes broke the shell quoting. The CI check never ran its logic. | Quoting fixed. |
| G6 | 3.15.0 | L297 | “fails on an empty rollback result” | The rollback leg of the smoke could come back empty (implied by the fix). | Fail on empty. |
| G7 | 3.11.0 | L445 | “the old fixture had no edges, so the suite couldn't see this class” | The fixture could not show the bug. | Edge-bearing fixture and a regression test. |
| G8 | 3.8.0 | L521 | “(it had never run clean)” | 24 bugs shipped on the belief that the Windows CI leg was green. | Both legs green; CI runs on every push. |

#### I. Inverse: false failure, false "owed", false alarm — 27

It reported a problem that was not there. Often CORE's own write tripped CORE's own detector.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| I1 | 3.20.1 | L19 | “A turn-capture row is no longer dropped when a purge removes the capture folder while the custody check is running” | A folder that vanished mid-check read as "could not be checked", and the row was refused. | Look again; read the folder as absent. |
| I2 | 3.20.1 | L23 | “it no longer shows as a pending edit every session” | CORE wrote the drift log without stamping it. Its own edit check flagged it each session. | Stamp it when written. |
| I3 | 3.19.2 | L70 | “used to force a stamp that the gate rejected” | The release gate demanded one exact commit and refused a later commit with the same bytes. | Accept a later commit that packages the same bytes. |
| I4 | 3.19.1 | L115 | “so a case variant or a filesystem root isn't refused” | The containment check compared spellings, so the same folder spelled another way was refused. | Compare on-disk spellings. |
| I5 | 3.19.1 | L118 | “The capture-latency test is reliable under load.” | A fixed 25 ms budget failed on a busy machine. | Scale the budget by measured load, with a ceiling. |
| I6 | 3.17.0 | L231 | “a false `CONTEXT-PARTIAL` every session” | Same wrong folder as the W row at line 233. Also a visibility row stuck at DEGRADED. | Key on the git worktree root. |
| I7 | 3.16.1 | L258 | “a second CI run on the same commit no longer blocks the tag” | A repeat CI run blocked a valid tag. | Fixed. |
| I8 | 3.15.1 | L271 | “no longer leaks a `hook-log-write-failed` diagnostic to the user on every answer” | In a sandbox the log folder was readable but not writable. The failure line reached the user every turn. | Fall back to a fixed temp log (later removed; see Section 4). |
| I9 | 3.15.0 | L307 | “surfaces its ENTIRE unit store as `no-baseline` on first contact” | The new stamping rule flagged every unit in an older store. | A one-time `--adopt-existing-store`. |
| I10 | 3.13.1 | L381 | “reliably flaky under real CPU contention” | Two tests inferred liveness from timing. | Probe/ack handshake. |
| I11 | 3.13.0 | L397 | “a full-path segment scan could also false-positive” | A folder named "archive" anywhere up the path tripped the check. | Check the immediate parent only. |
| I12 | 3.6.0 | L553 | “or cause a false drift report” | An interrupted write left a truncated index that read as drift. | Atomic writes. |
| I13 | 3.5.0 | L575 | “capability-drift no longer fabricates regressions from session-less rows or double-counts across stores” | Rows with no session were compared as if in order. | Fixed; later rebuilt on session lineage (commit 536f348). |
| I14 | 3.5.0 | L575 | “no longer shows contradictory `FAIL \| 1 \| 1` rows” | A report row said FAIL beside passing counts. | Consistent FAIL row. |
| I15 | 3.3.0 | L617 | “the workspace re-forked on every startup” | One side of the path compare used `resolve()`, the other `realpathSync`. | `realpathSync` on both sides. |
| I16 | 3.2.2 | L625 | “cross-project guard false-refused” | The dotted-username slug bug made the guard see two projects. | Shared slug helper. |
| I17 | 3.2.2 | L626 | “producing false `topics-format` warnings” | An inline YAML list was parsed as a string. | Parse flow-style arrays. |
| I18 | 3.2.2 | L627 | “false `dangling-edge` on `references-topic`” | Topic edges were checked as if they pointed at units. | Exempt them. |
| I19 | 3.2.2 | L628 | “A healthy store with orphan/stale warnings exited non-zero.” | Any warning blocked startup. | Exit 0 pass, 1 degraded, 2 hard fail. |
| I20 | 3.2.2 | L629 | “treats it as a malformed unit (6 schema FAILs)” | CORE's own old log file sat in the store and failed validation. | Remove the legacy file when writing the new one. |
| I21 | 3.2.1 | L636 | “the check kept forking the workspace” | The check matched on `path`; the schema said `project_path`. | Read either. |
| I22 | 3.1.1 | L654 | “every Windows install classified as `unknown` and its mutation gates failed closed” | Forward-slash literals were compared with a backslash home path. | Normalize both sides. |
| I23 | 3.1.1 | L655 | “degrading identity on every Claude resolution” | Both manifests sit in one folder; the Codex one was found first. | Prefer the consuming harness's manifest. |
| I24 | 3.1.0 | L668 | “`capability-drift-log` render no longer trips the unit validator” | CORE's own render failed CORE's own validator. | Underscore prefix so the validator skips it. |
| I25 | 3.0.0 | L695 | “flips `memory-accessed` from always-UNKNOWN on Codex to classifying” | Tool calls were not parsed from Codex transcripts, so the row could only say UNKNOWN. | Parse `function_call` and `custom_tool_call`. |
| I26 | 3.0.0 | L715 | “test passes when run from external project roots and installed plugin caches” | The test found its script by working folder and failed elsewhere. | Resolve from the test file's location. |
| I27 | 2.3.1 | L858 | “even when the plugin was correctly installed” | The resolver assumed one JSON shape, got another, returned empty, and startup warned the plugin was missing. | Handle the array shape. |

### 2.4 Adjacent entries

#### D. Instruments with no reader, no producer, or that could not fire — 16

Nothing false was reported. The thing was written and never read, or was wired to a condition that never happens.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| D1 | 3.19.0 | L154 | “which nothing does yet” | A skill promised that another step reads the source pull log. | Promise removed. |
| D2 | 3.17.0 | L199 | “no script, hook, or protocol consumed it and nothing read its output back” | `/vibecheck` wrote output nobody read. | Removed. |
| D3 | 3.16.1 | L264 | “Subsystems that were documented but had no producer” | The outcome pipeline "could only record unknown values" (L264-265). | Removed. |
| D4 | 3.15.0 | L301 | “nothing reached them” | The model-spawn close code had no caller. | Removed; a test asserts it stays gone. |
| D5 | 3.15.0 | L303 | “It was written every close and read by nothing” | Per-pass hygiene retrospective file. | Removed. |
| D6 | 3.14.0 | L357 | “tested helper, no production consumer” | Detector dedupe helper. | Kept, flagged. |
| D7 | 3.14.0 | L370 | “it could only fire on zero-hit turns, and a zero-hit has no delivered context to record” | Rich-context capture could only record empty context. | Removed in the release that listed it as added. |
| D8 | 3.14.0 | L371 | “never had a reader” | `CORE_RETRIEVAL_TRACE` output. | Removed. |
| D9 | 3.14.0 | L372 | “it never gained a reader in the roughly two months it ran” | OTel-format trace dual-write. | Removed. |
| D10 | 3.13.0 | L400 | “structurally dead code” | `analyze-source-pull-log.mjs`. | Removed. |
| D11 | 3.13.0 | L401 | “Its core mutation path was a permanent stub that always refused.” | `instruction-surface-adapter.mjs`, dry-run only. | Removed. |
| D12 | 3.5.0 | L568 | “the previously-dead mechanics-failure discriminator is wired” | A classifier branch that never ran. | Wired. |
| D13 | 3.4.0 | L590 | “the old gate never fired on real corpora and let PROJECT.md grow unbounded” | The demotion rule needed all cited units to be terminal. Real stores never met it. | Demote on checkbox plus age. |
| D14 | 3.0.0 | L711 | “documented in ROADMAP header but missing from the skill” | A regen step that no skill ran. | Added to `/finalize` (later removed again, commit ecb163b). |
| D15 | 2.8.0 | L758 | “do nothing at runtime yet” | `read-transcript` and `memory-accessed` shipped unwired. | Wired in 3.0.0. |
| D16 | 2.5.0 | L802 | “returned `0 demoted, 15 kept` as expected” | First run of state demotion moved nothing; the terminal-status set did not match the store's vocabulary. | Noted for follow-up. |

#### C. Words that claimed more than the code did — 23

A doc, notice, name, or comment promised a behavior the code did not have.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| C1 | 3.19.2 | L71 | “Skill prose now says what the code does.” | Retention, capture, baseline and close prose did not match code. | Prose aligned. |
| C2 | 3.19.1 | L79 | “The notice used to say the log "stays on this machine" and is "never exported".” | A synced folder syncs the log. | Notice corrected and re-shown once. |
| C3 | 3.19.1 | L80 | “the "you can purge everything" promise was false” | Purge left the classified log, which holds full turn text. | Purge covers it. |
| C4 | 3.19.1 | L85 | “docs that promised cleanup now say report” | Docs promised deletion. | Docs say report. |
| C5 | 3.19.0 | L141 | “no longer promises a deletion that no longer happens” | Notice promised 30-day auto-delete. | Notice corrected. |
| C6 | 3.17.0 | L200 | “instead of describing a live procedure” | A reference described session-log pruning that had been retired. | Reference corrected. |
| C7 | 3.16.1 | L254 | “removed an unsupported lifecycle-hook claim” | Docs claimed a hook that did not exist. | Claim removed. |
| C8 | 3.15.0 | L291 | “nothing in it establishes user benefit” | The export was named "memory-efficacy". | Renamed "memory-metrics". |
| C9 | 3.15.0 | L313 | “instead of mentioning capture only when it is already disabled” | `/metrics` disclosed capture only when it was off. | Discloses either way. |
| C10 | 3.14.0 | L360 | “wording overclaimed” | Skill said the exporter never reads unit bodies. It reads and discards them. | True claim stated. |
| C11 | 3.14.0 | L365 | “despite the file's own comment claiming single-owner safety” | Comment said safe; a 40-process probe lost 11 of 40 stamps. | Real lock. |
| C12 | 3.13.1 | L379 | “undercounted the companion-utility list” | Manifest descriptions were out of date. | Corrected. |
| C13 | 3.13.0 | L408 | “Corrected two v3.12.0 release-note inaccuracies” | Release notes overstated scope. | Forward correction. |
| C14 | 3.11.0 | L448 | “they claimed "no hooks" since v3.9.0 shipped them” | INSTALL and ARCHITECTURE were wrong for two releases; startup prose said default-off for a default-on hook. | Docs corrected. |
| C15 | 3.10.0 | L476 | “but that drop never shipped” | Schema comment said a field would be dropped in v3.8.0. | Comment corrected. |
| C16 | 3.8.0 | L513 | “The extension boundary is stated honestly.” | Spec-only layers read as built. | SPEC-ONLY legend. |
| C17 | 3.8.0 | L516 | “Docs no longer claim hooks ship via the plugin manifest” | Docs claimed automatic hook install. | Documented as manual. |
| C18 | 3.6.0 | L560 | “Documentation corrected on shipped surfaces” | Authority ordering, verbs, cross-references and counts were wrong. | Corrected. |
| C19 | 3.0.0 | L709 | “removed stale "Codex has no equivalent auto-memory" text” | Startup prose contradicted the Codex adapter. | Removed. |
| C20 | 3.0.0 | L710 | “(never closed)” | A probe named a release in which a risk would close. It did not. | Target moved. |
| C21 | 2.8.0 | L755 | “what actually shipped is the honest demotion, not hard enforcement” | 2.6.0 said a risk "closes in v2.8.0". | Stated as degraded. |
| C22 | 2.4.0 | L818 | “Old text said Codex has no auto-memory.” | Adapter text was wrong. | Corrected. |
| C23 | 2.3.3 | L835 | “The old name implied enforcement the behavior never had.” | `HARD_CAP_BYTES` never refused a write. | Renamed `SOFT_TARGET_BYTES`. |

#### O. Said "off" or "refused", wrote anyway — 3

The mirror image: the report said nothing happened, and something did.

| # | Release | Line | Quote | What went wrong | Fix applied |
|---|---|---|---|---|---|
| O1 | 3.19.1 | L77 | “used to store the first 300 bytes of the opening prompt in its summary and receipt” | With capture off, the automatic close still stored prompt text. | The close uses the same capture gate. |
| O2 | 3.19.1 | L86 | “The scorecard log and the self-test state were still written with metrics off.” | The off switch did not cover maintenance writes. | Writes gated. |
| O3 | 3.19.1 | L101 | “A refused run used to change the file anyway.” | The index stripped lines before its ownership guards ran. | Strip only after the guards pass. |

### 2.5 The same fault, fixed more than once

Eleven families. Each is one rule that lived in several places, or one promise made in several places, and was fixed one place at a time.

| Family | Times fixed | Where |
|---|---|---|
| The rule that turns a project path into the harness's folder name (the "slug") | 7 in the changelog, 1 more in git | L625 dots · L596 Windows drive letters · L521 drive colon stripped · L493 drive colon encoded · L393 two probes still wrong on Windows · L226–L236 git root, not working folder · L106 underscores · `ba71bce` two inline copies brought the dots bug back |
| A store walk that read only the top folder | 3 | L436 retrieval index (~42% of files unseen) · L178 ranking (about 4 in 10 units) · L158 edit check |
| A script decides it is not the entry point and exits 0 | 5 | L912 · L596 · L554 · L362 · L250–L251 |
| "Closed" said without the work behind it | 7 in the changelog, 2 more in git | L474 · L395 · L350 · L99 · L58 · L62 · L63 · `279b8c2` · `5aee6df` |
| An opt-out lost on one path | 5 | L151 · L150 · L105 · L86 · L51 |
| A bad flag value used anyway | 4 in the changelog, 1 more in git | L575 `--top` · L559 `--since-days` · L393 `--query` · L259 memory-view flags · `8daccad` |
| The build label (`source_sha`) stale or wrong | 3, plus 12 re-stamp commits | L378 · L358 · L187 (and the inverse, L70) |
| Registry key `path` against `project_path` | 4 | L636 · L476 · L155 · L64 |
| CORE's own drift log trips CORE's own checks | 4 | L708 · L668 · L629 · L23 |
| A transcript read for the wrong session | 2 in the changelog, 2 more in git | L518 · L93 · `ba71bce` · `1195972` |
| A privacy or retention notice that was not true | 5 | L314 · L313 · L141 · L79 · L80 |

**34 of the 132 "reported fine" rows** sit in the first ten of these families `[run: counted from the rows in 2.3]`. The eleventh family is words, counted in group C.

The project knows. Its own guard document says: “Several duplications (slug encoders, CLI-entry guards, frontmatter parsers) are *known debt* that isn't fixed yet.” (`docs/regression-guards.md:29`)

### 2.6 Found only in commit messages

These are in the class and have no changelog entry `[run: grep of CHANGELOG.md for each]`. 17 rows from 14 commits. I read commit subjects for all 699 commits but bodies for only about 30, so there are likely more.

| Commit | Date | Kind | What the message says |
|---|---|---|---|
| `5aee6df` | 2026-07-02 | Ran nothing | On Windows the background close could not start. “the SessionEnd self-managed close failed silently every session” (`5aee6df`) |
| `22130d8` | 2026-07-17 | Ran nothing | “async=true silently disables the Codex Stop hook” (`22130d8`) |
| `279b8c2` | 2026-07-28 | Swallowed error | The manual close called a function that was never imported. “the bare catch swallowed the ReferenceError” (`279b8c2`) and the only test asserted the failure case. The close “never wrote its receipt” (`279b8c2`). Caught before release. |
| `ad4f994` | 2026-07-22 | Empty read as zero | The bar gauge rounded small values to an empty bar, “indistinguishable from a hard 0%/failure state” (`ad4f994`) |
| `ad4f994` | 2026-07-22 | Swallowed error | “previously a JSON.parse failure vanished silently” (`ad4f994`), and a missing tier fell into the tier-1 bucket |
| `2027511` | 2026-07-28 | Empty read as zero | An unknown harness “returned zero rows with an all-zero summary” (`2027511`), the same as all-healthy |
| `2027511` | 2026-07-28 | Swallowed error | History lines that would not parse were dropped, “making a partly-corrupt history look like a shorter clean one” (`2027511`) |
| `e62a116` | 2026-07-28 | Fail-open | With no expected remote declared, the probe counted whatever remote it found as agreeing, “letting every proof pass” (`e62a116`) |
| `e62a116` | 2026-07-28 | Inverse | A repo simply not cloned yet “reported DEGRADED” (`e62a116`). Now NOT-YET. |
| `868e427` | 2026-07-28 | Inverse | A capture opt-out read as a broken recorder. “Deliberate disablement and lost capture produced the same silence” (`868e427`) |
| `536f348` | 2026-07-28 | Inverse | Two sessions running at once read as a capability that degraded and healed. |
| `5f48543` | 2026-07-21 | Exit 0 | `decorate-graph` CLI: “report and exit nonzero on refusals instead of silently claiming success” (`5f48543`) |
| `6c729f7` | 2026-09-27 | Fail-open | When the git call itself failed, the "is this file tracked" guard answered "nothing tracked". |
| `b9a04f3` | 2026-09-26 | Inverse | A deliberate non-zero exit printed the "plugin root unresolved" marker, so a user “would also be told the plugin was missing” (`b9a04f3`) |
| `ba71bce` | 2026-06-02 | Wrong place | Two inline slug copies: “read-transcript.resolveTranscriptPath mislocated the session transcript” (`ba71bce`) |
| `750cb2f` | 2026-07-18 | Mirror | `--dry-run` was documented and never parsed. It “performed the real write every time” (`750cb2f`). Also a test that “hardcoded producer_sha === 'unknown'” (`750cb2f`). |
| `7e792a1` | 2026-07-02 | Mirror | The per-turn hook created index files in folders that had no memory store. |

### 2.7 Still in 3.20.1

I found these while checking the leads in Section 3. I did not go looking across all 100 scripts, so this is a sample, not an audit.

| # | Where | What it does | Proof |
|---|---|---|---|
| 1 | `scripts/metrics-tripwires.mjs:60-67` | If the scorecard history cannot be read, or there is none, it returns healthy and prints nothing. The comment says so: “an unreadable history is healthy silence (nothing trustworthy to alarm about)” (`scripts/metrics-tripwires.mjs:60-61`). Startup then reads no output as no problem: “No output → say nothing” (`protocols/startup.md:483`). The call also throws away errors: `2>/dev/null \|\| true` (`protocols/startup.md:487`). | `[run]` On a project path that does not exist it printed nothing and exited 0. |
| 2 | `scripts/check-context-integrity.mjs:120-125`, `:143-151` | A file that is missing or cannot be read counts as 0 bytes and 0 lines. Zero is under every cap, so the marker is `CONTEXT-COMPLETE`. | `[run]` Pointed at a `MEMORY.md` and a `PROJECT.md` that do not exist, it printed `CONTEXT-COMPLETE` and exited 0. |
| 3 | `scripts/maintenance-run.mjs:90-126`, `:236-240` | In `--dry-run` the three index ops are still pushed onto the "ran" list (line 125 is outside the `if (apply)` block). The narration is in the past tense. | `[run]` `--dry-run` on a one-unit scratch store printed “Kept memory current: regenerated indexes + summary index.” No file was written. |
| 4 | `scripts/close-pass.mjs:216-228`, `scripts/generate-summary-index.mjs:177-187` | Close detection hashes whole unit files. CORE's own link block is in those files. A decoration-only rewrite reads as "store changed" and re-owes the render. | `[run]` See Section 3f. |
| 5 | `scripts/read-transcript.mjs` | The file has no command-line entry. Run as a command it prints nothing and exits 0. Lines that will not parse are dropped (`:206`, `:230`). A readable transcript that yields no events returns `available: true` with an empty list (`:291`). | `[run]` `node read-transcript.mjs --transcript /nonexistent/x.jsonl` printed nothing, exit 0. |
| 6 | `scripts/capability/memory-accessed-probe.mjs:82` | The header promises: “It never claims "not accessed" when it cannot see tool calls.” (`scripts/capability/memory-accessed-probe.mjs:23-24`) But the flag that guards this can never be set, because the reader hardcodes it (`scripts/read-transcript.mjs:275`). Zero parsed events gives DEGRADED, “no memory access of either kind observed in transcript” (`scripts/capability/memory-accessed-probe.mjs:82`). | Read from source. Not run. |
| 7 | `scripts/backfill-memory.mjs:44-47` | A receipt folder that exists but cannot be listed gives an empty list. The CLI then prints 0 sessions pending, exit 0. | Read from source. Not run. |
| 8 | `scripts/backfill-memory.mjs:77-84` | `mark` stamps a session as memory-processed. It takes no evidence. The skill says: “Mark a session even when it produced nothing” (`skills/process-memory/SKILL.md:76`). It gives no branch for a transcript that could not be read (`skills/process-memory/SKILL.md:70`). | Read from source. |
| 9 | `scripts/close-pass.mjs:491` | Every automatic close receipt carries the fixed text `ops: { capture: 'done', summary: 'done', … }`. That includes the close where no transcript could be read and the event list was empty (`:744-752`). The `status` field (`partial`) tells the truth. The `ops` field does not. | Read from source. |
| 10 | `scripts/close-pass.mjs:754-755` | `process-request` returns 0 whatever the receipt says, including `failed`. The hook that starts it throws its output away (`stdio: 'ignore'`, `hooks/close-pass-hook.mjs:114`) and logs `spawn` when the child starts, not when it ends (`hooks/close-pass-hook.mjs:118-120`). | Read from source. |
| 11 | `scripts/close-pass.mjs:679-682` | If the store cannot be read, the signature is `null` and detection uses the marker alone. A `closed` marker over an unreadable store reads as closed. | Read from source. |
| 12 | `hooks/hook-log.mjs:41-42` | When muted it returns `written: true`. With no project root it writes nothing. The session-end hook logs its "not a registered project" skip with `projectRoot: null` (`hooks/close-pass-hook.mjs:89`), so that receipt is never written. A registry that cannot be read looks the same as "not registered" (`scripts/close-pass.mjs:572`). | Read from source. |
| 13 | `scripts/decorate-graph.mjs:219-220` | A unit whose bytes could not be read is skipped. It is not counted as changed, unchanged or refused. The CLI can still print "none needed a change". | Read from source. |
| 14 | `protocols/startup.md:250-252`, `:275-281` | The shell form is `check && node script \|\| echo "…SKIPPED … (or CORE_ROOT unresolved — call skipped)"`. One message covers "did not run" and "ran and refused a file". The same form caused a false alarm fixed in `b9a04f3`. | Read from source. |
| 15 | `protocols/startup.md:470`, `:496`, `:507` | Two more calls end in `\|\| true`. And: “skip the capability probe silently” (`protocols/startup.md:507`). The same file says of another call: “Fail-open but never silent: don't add `2>/dev/null`” (`protocols/startup.md:465`). | Read from source. |
| 16 | `scripts/audit-memory-boundary.mjs:146` | A harness memory file that is not found becomes an empty string. The audit then reports on zero entries. | Read from source. |

### 2.8 Is it one class?

**One symptom, yes.** In every row a reader could not tell "did not measure" from "measured, and fine". The project names it itself: “Instruments report healthy while recording nothing” (`docs/regression-guards.md:13`). Its guard for it is “per-instrument tests; add as found” (`docs/regression-guards.md:13`). That is a list of patches, not a fix.

**One cause, no.** The 132 rows come from at least five different causes. Each needs a different cure.

1. **Guessed locations.** The code works out where the harness, or an older CORE, "must" have put a file. Group W, 24 rows.
2. **No way to say "unknown".** A read fails and the only values on hand are a number and a boolean. Group Z, 17 rows, and much of F.
3. **A word in place of evidence.** A status, a stamp, a lock, a label. Group T, 25 rows. Some of these rest on the agent's own say-so (L347, L851, row 8 in 2.7, and the op ledger in 3d). The project's own estimate is that “obligations that live only in prose get executed ~40% of the time” (`docs/change-review-prompt.md:17`). I found no data behind that figure.
4. **Copies that drift.** 34 rows (2.5). The author files this as a separate pattern from "instruments report healthy" (`docs/regression-guards.md:12-13`).
5. **Checks nobody saw fail.** Group G, 8 rows, and several in M.

**Five things in the record that do not fit a single class.**

1. **Exit 0 is sometimes the rule.** A hook must never block the user. 3.15.0 fixed two Codex hooks because they did *not* exit 0 on failure: “contradicting the always-exit-0 contract every hook in this plugin is supposed to honor” (L310). 3.20.1 then fixed one of those two hooks for exiting 0 with no trace (L24). Both fixes were right. The exit code was never the defect. The missing receipt was.
2. **Silence is sometimes the design.** “Healthy → total silence.” (L331) “All-PASS: silent” (L769). The first logger shipped “with silent-skip on bad project dir” (L866). The tripwire code calls an unreadable history “healthy silence” (`scripts/metrics-tripwires.mjs:61`). These were chosen, to keep the readiness summary calm. While quiet means healthy, anything that cannot speak is healthy.
3. **The opposite failure is large, and the cure causes some of it.** 27 inverse rows, 4 more in git, and the false "owed" in Section 3f. Several followed a fail-closed fix. Gates failed closed on every Windows install (L654). Any warning blocked startup (L628). The new stamping rule flagged every unit in an older store (L307) and CORE's own log (L23). The release gate refused a good stamp (L70). The Section 3f loop is two cures for silent success, L350 and L99, acting on each other.
4. **42 entries are not about a false report at all.** 16 instruments nobody read. 23 cases of words outrunning code. 3 cases of writing after saying no. The cures there are: delete it, generate the words from the code, and use one gate.
5. **A few are plain races.** A result was lost under load, not misreported by design (L19, L22, L49, L365).

**What this means for a planner.** Treat it as one symptom with a shared test: can a reader tell unmeasured from fine? Do not treat it as one bug with one fix. "Fail closed everywhere" is the fix this record warns against.

---

## 3. Specific leads

Each lead has three parts: what the changelog says, what git adds, and what the 3.20.1 source does today.

### 3a. `CLAUDE_CONFIG_DIR`, a second config tree, hardcoded `~/.claude` paths

**Changelog: not found.** No line mentions `CLAUDE_CONFIG_DIR`, a config dir, or a second config tree `[run: grep -n -i]`. No commit subject does either `[run]`. The one hit in the whole repo is a comment in a test script (`tests/smoke/in-project-state-installed-proof.sh:34`).

What the changelog does say. It names the `~/.claude` tree six times, always as a fixed place:

- L858 (2.3.1): the plugin root is read from `~/.claude/plugins/installed_plugins.json`.
- L840 (2.3.2): `MEMORY.md` lives in “the harness-managed `~/.claude/projects/<encoded>/memory/` folder” (L840).
- L608 (3.3.0): “MCP servers *declared* in `~/.claude.json`” (L608), and “the `~/.codex/config.toml` server list, which the script does not parse” (L608).
- L493 (3.9.0): “so `~/.claude/projects/<slug>` is a valid directory on Windows” (L493).
- L437 (3.11.0): a wrapper skill counts “only when registered in the user's own `~/.claude/settings.json`” (L437).
- L230 (3.17.0): memory scripts were “reading and writing `~/.claude/projects/<cwd-slug>/memory/`” (L230).

Three more entries are about *which* home folder, not which config folder: “the Claude-projects home seam honors `USERPROFILE`” (L521); “The trusted home now comes from `os.userInfo()`” (L441); and “`${CLAUDE_PLUGIN_ROOT}` is documented as not reliably injected into agent shell calls” (L550).

**Current source.** Eight shipped files build a harness path from the home folder plus a fixed folder name. None reads an environment variable for the config root.

| File and line | Path it builds |
|---|---|
| `scripts/read-transcript.mjs:76` | `<home>/.claude/projects/<slug>` — session transcripts |
| `scripts/read-transcript.mjs:95` | `<home>/.codex/sessions` |
| `scripts/check-context-integrity.mjs:66` | `<home>/.claude/projects/<slug>/memory/MEMORY.md` |
| `scripts/audit-memory-boundary.mjs:59` | the same `MEMORY.md` |
| `scripts/capability/auto-memory-injection-probe.mjs:56` | the same `MEMORY.md` |
| `scripts/capability/instruction-surface-resolution-probe.mjs:55` | `<home>/.claude/CLAUDE.md` |
| `hooks/session-start-hook.mjs:67` | `<home>/.claude/settings.json` |
| `scripts/configure-project.mjs:144`, `:150` | `<home>/.codex/config.toml`, `<home>/.claude.json` |
| `scripts/resolve-plugin-root.mjs:105-106` | `<home>/.claude/plugins/`, `<home>/.codex/plugins/` |

The probes take a `nativeHome` option. Nothing in the shipped tree fills it from the environment `[run: grep nativeHome]`. One more fixed path is a personal layout: `<home>/Documents/Projects/` counts as "canonical source" (`scripts/resolve-plugin-root.mjs:116`).

What each one reports when the file is not where it looked:

| Script | Result | Proof |
|---|---|---|
| `check-context-integrity.mjs` | `CONTEXT-COMPLETE`, exit 0 | `[run]`; `:120-125` turn a failed read into 0 |
| `capability/auto-memory-injection-probe.mjs` | NOT-YET, "MEMORY.md not found for mapped cwd" | `:72-76` |
| `audit-memory-boundary.mjs` | audits an empty string | `:146` |
| `read-transcript.mjs` | `no-project-transcript`; its six consumers say UNKNOWN or UNAVAILABLE | `:87-89`, `:288` |
| `capability/memory-visible-in-agent-context-probe.mjs` | UNKNOWN, "transcript unavailable" | `:72-73` |
| `close-pass.mjs certify` | `UNRESOLVED`, unless `--session` is passed | `:603-626`, `:768` |

I did not run these with a second config tree. The table is read from the code.

**Bottom line.** The changelog has seven fixes to the rule that names the folder (2.5), and none to the rule that finds the tree it sits in. The tree is assumed.

### 3b. Capability probe rows that said NOT-YET or UNKNOWN wrongly; the auto-memory probe

**Changelog, in time order.**

| Release | Line | What happened to a probe row |
|---|---|---|
| 2.6.0 | L766, L769 | First probes. Non-PASS rows are surfaced. “All-PASS: silent” (L769). |
| 2.8.0 | L740–L742, L751 | Canary echo probe ("memory was in context") and the auto-memory injection probe. A crashed probe now gives UNKNOWN. |
| 2.8.1 | L726 | The canary “shipped broken in v2.8.0” (L723). It could not pass. |
| 3.0.0 | L694, L695 | The truncation check measured lines, not bytes. `memory-accessed` was “always-UNKNOWN on Codex” (L695). |
| 3.1.1 | L654, L655 | **Wrong UNKNOWN:** “every Windows install classified as `unknown`” (L654). **Wrong DEGRADED:** identity degraded “on every Claude resolution” (L655). |
| 3.2.2 | L625 | Slug bug: the canary writer “returned `memory_written: false`” (L625). |
| 3.5.0 | L567, L573, L575 | **Wrong PASS** for an offline repo (L567). **Wrong PASS** from the canary's own text (L573). Fabricated regressions in drift (L575). |
| 3.13.0 | L393 | Two probes read the wrong memory folder on Windows. |
| 3.14.0 | L366 | The collab probe pointed every install at one person's repo. |
| 3.17.0 | L226–L236 | **Wrong DEGRADED, every session:** “perpetual `memory-visible-in-agent-context`” (L232) DEGRADED, and a false `CONTEXT-PARTIAL`, because the scripts read a folder the harness never injects. |
| 3.18.0 | L169 | The canary and its probe are removed. |
| 3.19.0 | L125 | New check that reads the transcript. Four states, each defined. “Codex has no equivalent record, so the check reports UNKNOWN there rather than guessing.” (L125) |
| 3.19.1 | L93 | **Wrong PASS or DEGRADED** from another session's transcript. Now UNKNOWN. |
| 3.20.1 | L15, L23 | A short row is described in plain words. The drift log stops showing as a pending edit. |

**Git adds.** `2027511`: a harness with no declared capabilities returned zero rows, which read as all healthy. `e62a116`: the collab probe said DEGRADED for a repo that was only not cloned yet, and the fix made that NOT-YET. `e111b07` (2026-09-25): the new transcript probe had ridden into 3.18.0 without review, “a release that was reviewed and stamped without them” (`e111b07`). It was pulled out and put back a day later (`da1b9b3`).

**A wrong NOT-YET: not found in the changelog.** The record has wrong UNKNOWN, wrong DEGRADED and wrong PASS. It has no entry for a NOT-YET that should have been PASS.

**Current source.** The auto-memory probe can produce exactly that.

- Its PASS means the file exists at the computed path and holds the heading `## Recent activity` (`scripts/capability/auto-memory-injection-probe.mjs:38`, `:90`). Its own header says “it does NOT prove the agent actually loaded the content into context” (`scripts/capability/auto-memory-injection-probe.mjs:7-8`).
- Its NOT-YET means only “NOT-YET — MEMORY.md does not exist for this mapped cwd” (`scripts/capability/auto-memory-injection-probe.mjs:20`). If the path is wrong (3a), a loaded memory file reads as NOT-YET.
- The transcript probe says NOT-YET when it finds no attachment record and no file at that same computed path (`scripts/capability/memory-visible-in-agent-context-probe.mjs:83-85`).
- The access probe can say DEGRADED when it parsed no events at all (2.7, row 6).
- All-PASS is still silent: “When all rows PASS, do not surface capability state in readiness” (`protocols/startup.md:505`). And if the probe cannot run at all: “skip the capability probe silently” (`protocols/startup.md:507`).

### 3c. An unattended, background or scheduled memory pass that claimed writes it did not make

**Changelog.** The exact incident, a pass that reported N writes and made none, is **not found** in the changelog or in any commit subject. The near history is this:

| Release | Line | Entry |
|---|---|---|
| 3.9.0 | L486 | `maintenance-run` arrives: “narrated (never silent)” (L486). “Autonomous/unattended maintenance stays gated behind explicit preconditions.” (L486) |
| 3.10.0 | L460, L463 | A SessionEnd hook “spawns a detached, recursion-guarded background close” (L460). The agent run's output goes to a log “so the background close isn't invisible” (L463). |
| 3.10.0 | L474 | **Direct hit.** “A failed background close no longer reports success.” (L474) The exit status was never read. A failed, killed or missing run was stamped closed. |
| 3.10.0 | L475 | A stranded lock could make closes “silently stop happening” (L475). |
| 3.13.0 | L395 | **Direct hit.** The close no longer certifies a session “when the LLM half of close recorded zero judgment ops” (L395). |
| 3.14.0 | L350 | Decoration was missing from the close's op list and went undone “for weeks” (L350). |
| 3.15.0 | L289, L295, L301 | The model-run background close is removed: “nothing reached them” (L301). The automatic close becomes “deterministic and zero-model, so it preserves a session without processing its memory” (L295). Memory work for those sessions moves to `/process-memory` back-fill. |
| 3.19.0 | L130 | Scheduled deletion stops. |
| 3.19.1 | L77, L85, L86 | The automatic close stored prompt text with capture off. `maintenance-run` “never deletes” (L85). Maintenance wrote metrics with metrics off. |

**Git adds.** `c431c8e`: “spawnSync result was discarded” (`c431c8e`), the cause behind L474. `5aee6df`: on Windows the background close never started, every session, and nothing said so. `279b8c2`: the manual close “never wrote its receipt” (`279b8c2`) because a caught error hid a missing import.

**Current source.**

- **No unattended memory pass exists.** “Autonomous maintenance — gated, not built” (`protocols/hygiene.md:155`), with four preconditions, “none yet built” (`protocols/hygiene.md:157`). The only background process is the SessionEnd close. It makes no model call and writes one receipt and one summary (`scripts/close-pass.mjs:425-437`).
- **The automatic receipt overstates.** Its `ops` block is fixed text, `capture: 'done', summary: 'done'`, written even when zero transcript events were read (`scripts/close-pass.mjs:491`, `:744-752`).
- **Nobody hears the background close finish.** Output is discarded, the log row marks the start only, and the exit code is always 0 (2.7, row 10).
- **Back-fill is a claim, not a check.** `mark` stamps “once the agent has actually read its transcript and captured what it warranted” (`scripts/backfill-memory.mjs:10-11`). The script cannot know that. The skill says to mark a session “even when it produced nothing” (`skills/process-memory/SKILL.md:76`). The skill gives no branch for a transcript that could not be read, so nothing stops that session being marked processed with nothing captured.
- **Back-fill's list can read zero wrongly** (2.7, row 7), though its header warns against exactly that: “an elided receipt would read as "nothing pending" when the truth is UNKNOWN” (`scripts/backfill-memory.mjs:14-15`).
- **`maintenance-run --dry-run` claims writes it did not make.** `[run]` It printed “Kept memory current: regenerated indexes + summary index.”, listed three ops as run, exited 0, and wrote nothing. The hygiene protocol says “`--dry-run` reports without writing” (`protocols/hygiene.md:153`). The report is in the past tense.

### 3d. Close markers, receipts and the close ledger: "closed" while work was owed, or "owed" wrongly

**Changelog, in time order.**

| Release | Line | Entry |
|---|---|---|
| 3.10.0 | L460 | Per-op close marker and a single-flight lock: “a crashed or failed close is detected and re-owed rather than falsely marked done” (L460). |
| 3.10.0 | L474 | Closed stamped over a failed run. Fixed. |
| 3.10.0 | L475 | A dead lock read as a live close. Fixed. |
| 3.13.0 | L395 | Closed certified with zero ops recorded. Fixed. |
| 3.14.0 | L350 | An op missing from the list was never owed. Backstop added. |
| 3.15.0 | L289, L294 | The close narrows to four ops. Manual close writes a receipt for its exact session, “so the SessionEnd hook can never run a second close over a session closed by hand” (L294). |
| 3.19.1 | L94–L98 | Five lock cases. A finish with no session could “remove a live owner's lock” (L94). |
| 3.19.1 | L99 | “A store changed after the last close owes its maintenance again.” (L99) |
| 3.19.2 | L58 | A receipt suppressed a close “on its status alone” (L58). |
| 3.19.2 | L59 | A re-signed bootstrap record could make startup skip. |
| 3.19.2 | L62 | “A partial or malformed close record no longer counts as a finished close.” (L62) |
| 3.19.2 | L63 | A manual close counted another session's ops. |

That is ten fix entries about the truth of one word, "closed", in five releases over three months (2026-06-30 to 2026-10-04).

**"Owed" wrongly: not found in the changelog.** The nearest entry is L96, where a dead lock read as a close still running. Nothing in the changelog says a render or op was owed when it was not.

**Current source.**

- **Two records of one close.** The marker has a status word and an op ledger. `finishClose` sets the word without reading the ledger (`scripts/close-pass.mjs:143-178`). Detection has to re-check, and its comment says why: “What `closed` alone can't rule out is the child exiting cleanly” (`scripts/close-pass.mjs:222`) without doing the work.
- **The ledger is the agent's word.** `record --op X --status done` writes "done" with no check (`scripts/close-pass.mjs:135-141`, `:706-709`). The file says so: “NOT a judgment engine. It tracks completion” (`scripts/close-pass.mjs:19`).
- **"Closed" can mean "no memory work was tried".** A `recorded` receipt stops any further automatic close for that session, and it means “automatic lifecycle evidence only, no semantic capture attempted” (`scripts/close-pass.mjs:275-276`).
- **Unreadable store reads as unchanged** (2.7, row 11): “null when the store cannot be read: detection then falls back to the marker alone.” (`scripts/close-pass.mjs:679`)
- **"Owed" wrongly, today.** See 3f. CORE's own decoration re-owes the render.
- **Claude Code only.** `const CLOSE_HARNESS = 'claude-code';` (`scripts/close-pass.mjs:417`). Certify finds the session from the Claude Code transcript folder (`:603-616`), so 3a applies here too.

### 3e. `read-transcript` failing open or returning empty

**Changelog.**

| Release | Line | Entry |
|---|---|---|
| 2.8.0 | L746, L758 | Added, “**not yet wired to a consumer**” (L746). “Gemini returns null; Codex tool-call extraction still pending” (L746). It and its probe “do nothing at runtime yet” (L758). |
| 3.0.0 | L695 | Codex tool calls parsed. The access row stops being always UNKNOWN. |
| 3.6.0 | L559 | “Codex array-form transcript events parse” (L559). Before that, this shape read as nothing. |
| 3.8.0 | L518 | Transcript resolved by session id, not newest file. |
| 3.19.0 | L125 | The new visibility check reads it. |
| 3.19.1 | L93 | With no transcript for the asked session, “the reader fell back to the newest transcript in the project” (L93). Checks passed on another session's evidence. |
| 3.20.0 | L44 | In project-only mode, transcripts are “reported as not observed” (L44). |

**Git adds.** `ba71bce`: an inline slug copy made it look in the wrong folder. `1195972`: after L93, every consumer had to be audited by hand: “audit every readTranscript consumer, not just the probe Hale found” (`1195972`).

**Current source.**

- It fails open on purpose and carries a reason: “Fail-open: never throws on a missing/unreadable transcript” (`scripts/read-transcript.mjs:266-267`). A missing file returns `available: false`, an empty list, and a reason. That part is sound.
- **Run as a command it does nothing.** No entry point. Prints nothing, exits 0 `[run]`.
- **Readable but unparseable looks like an empty session.** Bad lines are dropped one by one (`:206`, `:230`). The result is `available: true` with no events (`:291`). The header admits the Codex case: “the parser fails open to no-tool-events, never throws” (`scripts/read-transcript.mjs:30`).
- **The wrong-session fallback is still returned**, with a flag (`:82-89`). Six scripts import the reader, and each one checks the flag for itself `[run: grep session_mismatch]`. A seventh consumer that forgets brings L93 back.
- **The path is computed, not given** (`:76`, `:95`). See 3a.

### 3f. Startup decoration: rewriting link blocks, re-owing renders, churning change detection

**Changelog.**

| Release | Line | Entry |
|---|---|---|
| 3.13.0 | L386 | `/export-obsidian` writes a generated link block into each unit file. “Idempotent (a unit is only rewritten when its block actually changed)” (L386). |
| 3.14.0 | L373 | The command is retired. The same worker now runs by itself inside hygiene. |
| 3.14.0 | L350 | **Startup backstop.** Every returning session runs `decorate-graph.mjs` “(real run, not a dry-run)” (L350) and `maintenance-run.mjs`, whatever the close ledger says. |
| 3.14.0 | L364 | Decoration and hot-section stamped a fresh baseline over the whole file and could “silently launder an unreconciled user edit” (L364). Fixed by refusing. The backstop was “reordered to run after edit-detection” (L364). |
| 3.14.0 | L365 | The shared stamp file lost writes under load: “(29/40 survived)” (L365). |
| 3.15.0 | L307 | The new stamp rule flagged whole older stores as `no-baseline`. |
| 3.19.1 | L99 | A changed store re-owes the close's store-derived work. |
| 3.20.1 | L21, L23 | Stamps claim only bytes written. CORE's drift log no longer shows as a pending edit every session. |

**Re-owing renders: not found in the changelog.** No entry says decoration makes the close detector owe a render.

**Git adds.** `5f48543`: the decoration CLI used to claim success on refusals. `67826b2` (2026-10-03): the docs had said decoration ran at `/finalize`; it runs at startup. `7ad671b` and `ac6b415`: decoration was added and reverted on the same day before it stuck.

**Current source: the re-owe is real.** The chain:

1. Startup runs decoration for real, every session: it “runs for real, unconditionally, every session, on every returning workspace” (`protocols/startup.md:272`). It “regenerates the `[[wikilink]]` block in every active unit” (`protocols/startup.md:293`). The close itself does not decorate: “`/finalize` performs no maintenance.” (`protocols/startup.md:305`) So a unit written during a session gets its link block at the next startup, unless the user runs `/process-memory` first (`skills/process-memory/SKILL.md:165`).
2. Right after, startup runs close detection (`protocols/startup.md:307-320`).
3. Detection compares a signature of the store with the one saved at close. The signature hashes each unit file whole, link block included (`scripts/generate-summary-index.mjs:177-187`).
4. A `closed` marker with a different signature returns owed, for the store-derived op, which is `render-project-md` (`scripts/close-pass.mjs:227-228`, `:242-244`).

`[run]` I checked steps 3 and 4 on a two-unit scratch store. I wrote a `closed` marker with the store's own signature. `close-pass.mjs detect` printed `{"state":"closed","owed":[]}`. I then added only the generated block to one unit, using the product's own `decorateUnitText`. `detect` printed `{"state":"owed","owed":["render-project-md"],"reason":"store-changed"}`. Limit of this check: I applied the block with the exported function, not by running `decorate-graph.mjs`, which also needs a baseline stamp before it will write (`scripts/decorate-graph.mjs:254-258`).

**Churn in the indexes too.** `maintenance-run` uses the same signature to decide whether units changed (`scripts/maintenance-run.mjs:88-89`). It runs straight after decoration at startup. A decoration-only change makes it rebuild both indexes and the summary index and stamp them again (`:90-126`).

**Change detection itself is not fooled.** Decoration stamps its own write, with a hash of the part outside the block (`scripts/decorate-graph.mjs:278-283`). The edit check is built to read that as CORE's write (`protocols/startup.md:266`). So the churn is in the close signature and the index ledger, not in edit detection. I did not run the edit check.

**The cost of the design.** To put generated text inside files a person edits, CORE carries a state cache, a per-file stamp, an outside-the-block hash, a refusal rule, an ordering rule, a creation-stamp command, and two adoption ceremonies (`protocols/startup.md:247-295`). At least eight changelog entries are fixes to that machinery: L364, L365, L394, L307, L49, L21, L23, L20.

### 3g. The Windows bug family: paths, encoding, OneDrive, CRLF, hooks

20 of the 46 releases have at least one entry that names Windows, OneDrive, CRLF or a Windows path rule `[run]`.

| Kind | Entries |
|---|---|
| Path separators | L829 backslashes in the plugin root · L830 backslashes break memory-index links · L654 backslash home against forward-slash literals, so every Windows install was `unknown` · L521 “path builders use `posix.join`” (L521) |
| Drive letters and colons | L596 · L521 “project slugs strip the drive colon” (L521) · L493 the colon is encoded instead · L393 two probes still wrong · L114 the instruction walk “stops at the drive root” (L114) |
| Path case and short names | L115 a case variant was refused · L125 paths compared “case-insensitively on Windows” (L125) · `ed68e24` 8.3 short names |
| Wrong root | L666 an empty `CORE_ROOT` resolved against “the Git-Bash MSYS root on Windows, dying silently” (L666) |
| Module loading | L521 “dynamic `import()` now uses `file://` URLs” (L521) · L596 the entry check never matched on Windows · L117 · L27 |
| Line endings | L556 CRLF stopped the validity stamp · L592 “Frontmatter parsers are CRLF-tolerant” (L592) · L169 the canary strip handles “LF or CRLF” (L169) |
| OneDrive and sync folders | L788 metrics redirected to AppData on OneDrive · L617 sync roots re-forked the workspace every startup · L840 link paths ran through cloud storage · L135, L147 redirect edge cases · L60 the log split across two folders · L79 the redirect is dropped |
| Archive tools | L393 a corrupt zip shipped silently on a GNU-tar machine · L423 a tar bug in the test harness |
| File permissions | L341 owner-only modes are “best-effort on Windows” (L341) |
| Hooks and processes | `5aee6df` the background close could not start `claude.cmd` · L19 a custody race, “3 of 60 isolated runs on Windows before, 0 of 60 after” (L19) |
| Tests | L116 refusal tests skipped on Windows · L521 the Windows CI leg “had never run clean” (L521) |

Two things stand out. First, the worst of these were silent: L666, L596, L393, `5aee6df`. Second, they were found by use on a real Windows machine, not by tests: “surfaced by on-box Windows use” (L633), “surfaced by on-box Windows validation” (L651), “confirmed live against a real installed Windows cache, still broken in the prior release” (L393).

### 3h. Codex-specific gaps and fixes

19 of the 46 releases mention Codex `[run]`.

**Changelog.**

| Release | Line | Entry |
|---|---|---|
| 2.0.1, 2.0.2 | L918, L907 | Codex adapter. |
| 2.4.0 | L818, L819 | Adapter said Codex has no auto-memory; corrected. Codex manifest version was stale. |
| 2.5.0 | L795 | Session id falls back to `CODEX_THREAD_ID`. |
| 2.8.0 | L746 | Codex tool-call extraction “still pending” (L746). |
| 3.0.0 | L695, L698–L701, L716 | Tool calls parsed. A separate `plugins/core/` tree for the Codex marketplace. Capability history falls back into the project when the Codex sandbox blocks the home folder. |
| 3.0.0 | L712, L713, L715, L719 | Four fixes found by running on Codex. |
| 3.1.1 | L655 | The Codex manifest, found first, degraded identity on every Claude Code run. |
| 3.2.0 | L646 | One tree for both harnesses. |
| 3.3.0 | L607, L608 | `/configure-project` as the Codex setup step. The Codex server list is not parsed. |
| 3.6.0 | L559 | A Codex transcript shape that parsed to nothing. |
| 3.10.0 | L466 | “On Codex (no validated SessionEnd-equivalent) the close is startup-catch-up-only” (L466). |
| 3.14.0 | L342 | No artifact surface on Codex: a local file path, “never a faked publish” (L342). |
| 3.15.0 | L310 | Both Codex hook wrappers crashed instead of exiting 0 when the shared code failed to load. |
| 3.15.1 | L272 | In the Codex sandbox `~/.core` is readable and not writable. The log failure reached the user every turn. |
| 3.17.0 | L203 | With no contract file: Claude Code errors, “Codex: clean skip, exit 0” (L203). |
| 3.19.0 | L125 | The memory-visibility check is UNKNOWN on Codex. |
| 3.20.1 | L24 | The Codex retrieval hook leaves a receipt when it cannot load. |

**Git adds.** `22130d8`: a copied `async: true` flag turned the whole Codex Stop hook off, silently. `4e04717` built a Codex post-answer hook; `6ba01fe` deleted it two weeks later with the outcome pipeline.

**Current source: what Codex does not get.** The adapter lists five drops (`harnesses/codex.md:77-97`): notifications, scheduling, automatic session start, automatic close, and blocking before a tool runs. Only one hook is registered, `UserPromptSubmit` (`hooks/hooks-codex.json`). So on Codex “there is no `SessionStart`-equivalent door, so nothing invokes `startup.md` on its own” (`harnesses/codex.md:85`), and “Automatic close DROPPED” (`harnesses/codex.md:91`). The close code is fixed to one harness (`scripts/close-pass.mjs:417`). The Codex hook's own comment states the rule the whole class breaks: “a total outage must not look like a quiet turn” (`hooks/retrieve-context-hook-codex.mjs:19-20`).

**Pattern.** Much of the Codex support was checked against documentation and field reports, not on a live install. Four fixes in 3.0.0 came from someone running it on Codex (L712, L713, L715, L719). One commit says its fixes were checked “against the cited documentation, not by a live Codex install this session still doesn't have” (`22130d8`).

---

## 4. What was removed or walked back

These are things the author built, then decided were not worth carrying. The reason is quoted where the changelog gives one.

### 4.1 Removed features and commands

| Release | Line | What went | Stated reason |
|---|---|---|---|
| 3.1.0 | L675 | Gemini harness: manifest, adapter, generator, detection | Gemini CLI has no callable-skill surface; “it didn't work in practice” (L675) |
| 3.7.0 | L536 | `/organize-files` | “it was a general-purpose tool, separate from CORE's project-intelligence mission” (L536) |
| 3.11.0 | L451 | Dense / ollama embedding arm, before release | “per the standing rule that CORE runs no local models” (L451) |
| 3.12.0 | L421 | Two env vars that redirected telemetry | Security: “the two store variables were removed outright” (L421) |
| 3.13.0 | L400 | `analyze-source-pull-log.mjs` | “structurally dead code” (L400) |
| 3.13.0 | L401 | `instruction-surface-adapter.mjs` | “a dry-run-only v3.0 instruction-surface system with no real caller in the product” (L401) |
| 3.13.0 | L402 | `render-okf-export.mjs`, the separate export folder | “superseded by the in-place `[[wikilink]]` decoration” (L402) |
| 3.14.0 | L369 | The user-benefit row in `/metrics` | “measuring what the user did with delivered answers is unobservable, so the question left scope by decision rather than by gap” (L369) |
| 3.14.0 | L370 | Opt-in rich-context capture | “it could only fire on zero-hit turns, and a zero-hit has no delivered context to record” (L370). Its script is in no release tree `[run]`: added and removed between two releases. |
| 3.14.0 | L371 | `CORE_RETRIEVAL_TRACE` | It “never had a reader” (L371) |
| 3.14.0 | L372 | OTel-format trace dual-write (added 2.5.0, L795) | “it never gained a reader in the roughly two months it ran” (L372) |
| 3.14.0 | L373 | `/export-obsidian` as a command (added in 3.13.0, L386) | “retired as a user-invoked command” (L373); the worker runs by itself |
| 3.15.0 | L301 | The model-spawn close: `runClose`, the `run` verb, envelope env vars (added 3.10.0, L460) | “nothing reached them” (L301) |
| 3.15.0 | L302 | `/metrics-package` and `/self-test` shims | Removed “on their announced one-release schedule” (L302) |
| 3.15.0 | L303 | Per-pass hygiene retrospective file | “It was written every close and read by nothing” (L303) |
| 3.15.0 | L304 | Mailbox: `_mailbox/`, `mailbox.mjs`, the unread-count hook (nudge added 3.13.0, L388) | “It was internal coordination infrastructure, not a capability any `/core` project needs” (L304) |
| 3.15.0 | L288 | Unbuilt design specs and internal narrative in tracked files | “unbuilt design specs are removed from every tracked file” (L288). Git: the adversarial-artifacts schema and validator went in `fabf89b`. |
| 3.16.1 | L264–L265 | Outcome pipeline (added 3.12.0, L415), an experiment-only branch in retrieval | “Subsystems that were documented but had no producer” (L264); it “could only” (L264) “record unknown values” (L265). Git: both answer-close hooks and `record-retrieval-outcome.mjs` went in `6ba01fe`. |
| 3.17.0 | L198 | `/orient` (deprecated 3.6.0, L543) | “the deprecation shim's sunset (2026-08-15) passed” (L198) |
| 3.17.0 | L199 | `/vibecheck` | “no script, hook, or protocol consumed it and nothing read its output back” (L199) |
| 3.18.0 | L165 | A/B/C promotion modes for memory writes | “the A/B/C promotion modes are gone” (L165). The agent decides. “Nothing is deleted, so a wrong call is recoverable.” (L165) |
| 3.18.0 | L169 | The memory-visibility canary, its writer, its probe, the echo rule (added 2.8.0, L740–L741) | “An instruction arriving through injected memory looks exactly like a prompt injection, and users were getting alerts.” (L169) |

### 4.2 Replaced by something simpler

| Release | Line | Before | After |
|---|---|---|---|
| 2.1.0 | L901 | Two version files | One. The second was “removed as a redundant (and stale) source” (L901) |
| 2.3.3 | L835 | `HARD_CAP_BYTES` | `SOFT_TARGET_BYTES`: “The old name implied enforcement the behavior never had.” (L835) |
| 3.1.1 | L659 | A special-case validator guard | “Dropped a redundant `RENDER_ONLY_ARTIFACTS` validator guard” (L659); a filename prefix does the job |
| 3.2.0 | L646 | Two copies of the plugin tree, kept in step by rsync | One tree. “Tests live at the repo root and no longer ship in the install bundle (install drops from ~2.4 MB to ~1.2 MB)” (L646) |
| 3.3.0 | L604 | A planned connector name-map | “CORE ships no connector name-map” (L604), “because a grep proved CORE hardcodes zero connector names” (L604) |
| 3.4.0 | L590 | Demote only when every cited unit is terminal | Demote on checkbox plus age. “the old gate never fired on real corpora and let PROJECT.md grow unbounded” (L590) |
| 3.4.0 | L591 | Validity as its own layer | Validity as fields on a unit, “not a standalone subsystem” (L591) |
| 3.8.0 | L510 | A bash-only root resolver | One line for five shells: “the bash-only resolver block is gone” (L510) |
| 3.15.0 | L289 | `/finalize` as a long close with maintenance inside | Four ops, “and does nothing else” (L289). Commit `2182c29`: “(334 → 120 lines)” (`2182c29`) |
| 3.17.0 | L203, L204 | Four generator scripts | Two: “One wrapper” (L203), “One `KINDS` table” (L204) |
| 3.17.0 | L200 | `protocols/self-evolution.md` | Folded into hygiene. And “session-log auto-prune is retired without replacement” (L200) |
| 3.20.0 | L36 | One stamp lock shared by all projects | “there is no stamp lock shared between projects” (L36) |

### 4.3 Reversals

Each row is a position the project took, then took back.

| First | Then | Lines |
|---|---|---|
| Metrics are “default-off, opt-in per workspace” (L582), 3.4.0 | “Metrics capture defaults to on, opt-out.” (L546), 3.6.0. Commit `267f186`: “reversing the privacy default” (`267f186`) | L582, L546 |
| Push always asks | “reframed from universal-confirm to per-user, per-repo with safe default” (L888) | L888 |
| Cloud-sync duplicates are deleted: “automatically remove macOS cloud-sync duplicate files” (L893), 2.1.0 | “`maintenance-run` never deletes.” (L85), 3.19.1 | L893, L85 |
| Captured turns are deleted after 30 days (L326) | “Maintenance no longer deletes turn-capture rows or the classified turn log on a schedule.” (L130) And “there is no size-based replacement yet” (L130) | L326, L130 |
| Each artifact publish waits for a yes (L349) | “Artifact publishes are narrated, not permission-gated.” (L348), “per the user's direct decision (2026-07-22)” (L348) | L349, L348 |
| On Windows with OneDrive, metrics go to AppData (L788), 2.5.0 | “New Windows OneDrive projects no longer redirect to AppData.” (L79), 3.19.1 | L788, L79 |
| A signed pin decides where captured turns go (L143), 3.19.0, with ten more fixes about it in the same release | “nothing routes by a pin now” (L60), 3.19.2, five days later | L134–L147, L60 |
| A synced project keeps fast state on the machine (L78 describes it) | “All of it now lives in `<project>/.core/<harness>/`, the same as for any other project.” (L78) | L78 |
| Project state lives under a machine-wide folder | It moves into the project, 3.19.0 (L129). Then the folder is renamed `.core` to `_core`, 3.20.0 (L33). “The account-wide `~/.core` folder keeps only CORE's trust anchors” (L35) | L129, L33, L35 |
| The session summary shrinks: “The session summary is now a one-line trace plus a short resume stub” (L462), 3.10.0 | Commit `cbe6301` two days later: “full narrative summary every close” (`cbe6301`). Then 3.15.0: “a resume summary capped near 400 words” (L289) | L462, L289 |
| Hook log falls back to a temp folder in sandboxes: “fall back to a fixed, trusted tmpdir log” (L273), 3.15.1 | Gone in 3.20.1: “No global or OS-temp fallback.” (`hooks/hook-log.mjs:1`) | L273 |
| A risk “closes in v2.8.0” (L781) | “what actually shipped is the honest demotion, not hard enforcement” (L755) | L781, L755 |
| The registry field `project_path` “stays read-tolerated for one release, then drops” (L612), 3.3.0 | Never dropped: “that drop never shipped” (L476). Still read under both spellings in 3.19.2 (L64) | L612, L476, L64 |

### 4.4 Walked back in git, with no changelog entry

- `317ba5d` (2026-06-02): `protocols/clusters.md` retired. It was added in 2.2.0 (L879).
- `6c37f51`: “Remove vestigial RELEASE.json + its CI check” (`6c37f51`). `fa71750`: the `BUILD` file goes.
- `1c9823f`: a skills manifest and a "refresh hold" convention pulled as “out of scope” (`1c9823f`), the day they were added.
- `ecb163b`: ROADMAP regeneration removed from `/finalize`. It was added in 3.0.0 (L711).
- `773dfd9`, `4a788b6`: two metrics features landed and were reverted on the same day (2026-07-17).
- A `retired-in-active` check was added (`6403e47`), reverted (`adf010a`), re-added (`ab1bf81`) and removed (`769ab64`, “contradicts protocols/hygiene.md” (`769ab64`)), all on 2026-07-21.
- The canary was first made data-only (`1b330bd`), then removed the same day (`c8cf519`).
- `e308f8a` deleted `/orient` on 2026-06-05. `d12b1f3` put it back as a no-op shim the next day.

### 4.5 Declared open, deferred or out of scope

- “CORE does not defend against a concurrent same-user process racing the filesystem” (L60).
- The memory-visibility question “is open again” (L169).
- Reasoning-tier retrieval: “no calibrated measurement yet of its effect on retrieval quality” (L413).
- Lexical noise in per-turn retrieval: “a reasoning-based de-noiser is the planned next step” (L485).
- “Autonomous/unattended maintenance stays gated behind explicit preconditions.” (L486) Still “gated, not built” in 3.20.1 (`protocols/hygiene.md:155`).
- “End-to-end retrieval-effectiveness proof remains `NOT-YET`” (L704).
- Codex has no automatic close (L466).
- Downgrade is not supported after 3.20.0: “Old CORE versions don't know the `_core` folder.” (L40)

### 4.6 What the removals have in common

Three reasons cover most of the list. **Nobody read it** (L372, L371, L303, L199, L264, L301). **It could not work as built** (L675, L370, L401, L590). **It was more machinery than the job needed** (L646, L203, L289, L60). Routing by pin is the sharpest case: 11 "Fixed" entries in 3.19.0 are about the pin and the folder it points at (L134–L140, L142–L144, L147), and five days later routing by pin is deleted.

---

## 5. Evaluation history

How CORE tests and measures itself, in the order it arrived.

### 5.1 Timeline

| Release | Line | What arrived | What it measures | Limit or admission |
|---|---|---|---|---|
| (before 2.0.1) | — | `validate.mjs`, a retrieval simulator. In the tree at the first visible commit `[run]`. | Whether expected units rank for a set of queries | Later “labeled NOT-PRODUCT-PATH (diagnostics only, never a release gate)” (L448). Kept in 3.17.0 “for historical validation comparability” (L205). |
| 2.1.0 | L895–L897 | Version-check CI gate, auto-tag, `/cut-release` “with 11 pre-flight checks” (L897) | That manifests agree; that a release can be cut | — |
| 2.3.0 | L874 | Hygiene event log | PROJECT.md upkeep: “effectiveness measured via hygiene-log events, not user review” (L874) | — |
| 2.4.1 | L807 | A prose rule, “Part of the measurement window running through 2026-05-31.” (L807) | Recognition failure | No result is reported anywhere in the changelog `[run: grep]`. |
| 2.5.0 | L786–L796 | Metrics storage scaffold, OTel dual-write, “41 unit tests” (L796) | Nothing yet; storage only | The dual-write was removed unread (L372). |
| 2.6.0 | L766–L769 | Capability probes with PASS / DEGRADED / UNKNOWN rows | Whether a harness feature is present | See 3b. |
| 2.8.0 | L737–L741, L760 | Capability history and drift. The visibility canary. First test files in the repo `[run]`. “Every new script ships with unit tests under `tests/scripts/`; the script suite passes at cut.” (L760) | Drift between sessions. Whether memory reached the agent. | Two instruments ship unwired (L758). |
| 2.8.1 | L729, L730 | — | — | “Independent adversarial review was still outstanding at release time” (L729). The canary PASS “is not yet demonstrated” (L730). |
| 3.0.0 | L685, L689, L693 | Fail-closed release gate. Retrieval-event producer. Transcript scan for skipped retrieval: “candidates not verdicts” (L693). | Whether retrieval happened and what it returned | “End-to-end retrieval-effectiveness proof remains `NOT-YET`” (L704). Three scoring bugs fixed in the same release (L707, L712, L713). |
| 3.1.1 | L658 | CI guards on script imports; a mirror parity gate | That two trees match | The mirror is deleted one release later. |
| 3.2.0 | L643 | Retrieval rows from the main load path | Real retrievals | Until then the analyzer read “empty telemetry” (L643). |
| 3.4.0 | L582, L585, L587 | Six-state recognition classifier, daily rollup, three detectors. Calibration harness. Orphan detector. | Whether the agent recognized project facts. Whether each script is reached by a skill. | “The classifier is **PROVISIONAL**: uncalibrated until ~100 hand-labeled turns clear a 0.7-precision gate” (L582). Precision “is computed only from human labels, never the classifier's own output” (L585). |
| 3.5.0 | L568, L569, L573 | Fixes to the classifier, the gate and the canary | — | All three had been passing wrongly. Suite 445 → 482 (L564). |
| 3.6.0 | L546, L558 | Metrics on by default | — | “The classifier stays PROVISIONAL until a human-labeled set clears a 0.7-precision gate” (L546). The worksheet had double-counted toward that gate (L558). |
| 3.8.0 | L501, L505 | A whole-tree audit: “The audit produced 111 findings” (L501). CI on Linux and Windows with doc-drift, hooks-schema, lint and release gates. | — | The Windows leg “had never run clean” (L521). Suite 528 → 681. |
| 3.9.0 | L497 | In-context proxy v2 “with an over-fire regression guard” (L497) | Part of the recognition classifier. The changelog does not define it further. | The proxy had over-fired (implied by the guard). |
| 3.10.0 | L470, L478 | A pre-release adversarial security review. Suite 739 → 771. | — | — |
| 3.11.0 | L438, L431, L429, L433, L434 | Recall@K harness on a pre-registered gold set, with “forbidden-retrieval rate” (L438). Strict evaluator that “refuses under-declared queries” (L431). Measurement of delivered bytes. Safety battery. The “16-check packaged-install procedure” (L434) in CI. Regression-guard document first in the tree `[run]`. | Retrieval recall and wrong-recall on fixtures. Install, rollback and hostile-environment behavior. | No score is reported in the changelog. |
| 3.12.0 | L413, L414, L415 | Build label on every outcome row. Outcome-tracking core. | Which build made a row | Reasoning tier: “no calibrated measurement yet” (L413). Outcome tracking: “not yet exercised on an installed artifact in production” (L415), then removed (L264). |
| 3.13.0 | L387, L392, L393 | A test-only switch for “the memory-efficacy pilot” (L387). An independent audit. Live confirmation on Windows. | — | No pilot result appears in the changelog. |
| 3.14.0 | L326–L340, L352–L353 | Turn capture. Pinned scorecards. Hindsight judge. Startup tripwires. Blind self-test rounds. `/metrics` with labelled evidence classes. | Did retrieval find the right stored text, graded after the fact. Can the store answer questions written without seeing the code. | “Every verdict is labeled `mechanical grade`” (L330). Self-test is “still honestly labeled `provisional` (self-authored answer key, no preregistered pass threshold)” (L340). User benefit: “no matched memory-on/off comparison exists anywhere in this codebase yet” (L353). |
| 3.14.0 | L357, L363 | Calibration cohorts; replay dedupe | — | Two live measurement errors: mixed instruments, and 11% inflation. |
| 3.14.1 | L321 | Dev-leakage guard in the release gate | That no internal names ship | — |
| 3.15.0 | L288, L296, L297, L298 | Planted falsifiers for the leakage guard. Shipped-surface inventory with a count-claim guard. Release-identity gate: “tag creation requires the CI workflow for that exact SHA to have succeeded” (L297). Blind prose evals: “A deterministic rubric checker scores `/refocus` answers and finalize resume summaries against scenario fixtures with planted expectations” (L298). | That docs match the tree. That the release is the reviewed bytes. That prose output keeps obligations and ignores planted injections. | The export is renamed because “nothing in it establishes user benefit” (L291). |
| 3.15.0 | L311, L312 | Silence detection in the health chain. A sample-size rule. | Whether the recorder is alive | Before: “an idle recorder read as a healthy one” (L311). |
| 3.16.1 | L250–L253 | A regression test that keeps scripts on one entry helper. Dirty tree refuses gated tests. | — | Green had not always meant "ran". |
| 3.17.0 | L195, L205, L219–L222 | Escalation rate in the analyzer. An `escalated` harness arm. | How often retrieval falls back to reasoning | Review gap admitted: “the requested code review was withdrawn before it happened” (L195). The arm prints “— (no reasoner configured)” (L222) without a reasoner. |
| 3.17.1 | L187 | Freshness check “on every cut” (L187) | Build label | Every 3.17.0 metrics row named the wrong build. |
| 3.18.0 | L169 | — | — | The canary is removed. Its question “is open again” (L169). |
| 3.19.0 | L125 | Transcript-based memory-visibility check | That the harness attached `MEMORY.md` | “PASS means the harness loaded the file. It doesn't show that the agent used it” (L125). Claude Code only. |
| 3.19.1 | L93, L103, L119 | Nine fixes “each with a mutation-checked test” (L103). “Tests now fail under the failures they name.” (L119) | — | The memory checks had passed on another session's transcript (L93). |
| 3.19.2 | L70 | Release gate accepts a later commit with the same bytes | — | The gate had refused a good stamp. |
| 3.20.0 | L50 | Calibration shown as unavailable, not zero. In the tree: `tests/acceptance/`, `tests/isolated-controls/`, an isolated suite runner `[run]`. | That the suite does not write to the real home folder | — |
| 3.20.1 | L27 | Deterministic custody cases; smoke fails if the caller's project state changes | — | — |

### 5.2 What the record never shows

- **No quality result.** In 46 releases the changelog reports no retrieval score, no classifier precision, and no statement that the 0.7 gate was ever cleared `[run: grep for Recall@, precision, cleared, calibrated, %]`. The numbers it does report are sizes of its own errors: “~11% inflation” (L363), “55 of 147 deduped rows” (L357), “~42% of CORE's memory files were invisible” (L436), and one validation run, “(4/5 pass, 1 fail)” (L713).
- **No with-and-without comparison.** The changelog says so (L353), then drops the row (L369).
- **The classifier is still provisional as far as the changelog tells.** Marked PROVISIONAL at L582, L546, L568. No entry lifts it.

### 5.3 Entries that admit a measurement was wrong, provisional or removed

- **Wrong:** L828, L713, L712, L707, L694, L643, L573, L569, L568, L558, L497, L447, L378, L363, L357, L353, L311, L187, L93, L50.
- **Provisional or not yet shown:** L730, L704, L600, L582, L546, L415, L413, L340.
- **Removed or renamed:** L372, L370, L369, L291, L264, L169.

### 5.4 The project's own list of what goes wrong

Since 3.11.0 the repo carries a guard document. It names five repeating defect shapes (`docs/regression-guards.md:11-15`): prose rules the agent will not reliably run; a fix made in one copy and not the others; “Instruments report healthy while recording nothing” (`docs/regression-guards.md:13`); soft trust boundaries; and a read rule with no single owner. Shapes 2, 4 and 5 have mechanical guards. Shape 3 has none of its own: “per-instrument tests; add as found” (`docs/regression-guards.md:13`). Shape 1 is “manual for now” (`docs/regression-guards.md:11`).

---

## 6. Security history

One line each. Three terms asked for are **not in the changelog** under that name `[run: grep -n -i]`: "install secret", "restrictive mode" and "untrusted". The nearest entries are listed under each heading.

### Who may trigger CORE (trust boundaries)

- 2.6.0, L765–L768 — Plugin identity gate. The doctrine “fail-open-observation/fail-closed-mutation” (L768).
- 3.1.0, L667 — The memory index refuses to write one project's units into another project's `MEMORY.md`.
- 3.5.0, L567 — The adversarial-run gate and the collab probe fail closed.
- 3.10.0, L470 — The background close runs only in a registered project, “not merely a directory that happens to contain a `_memories/` folder” (L470).
- 3.11.0, L437 — A wrapper plugin's start skill counts only when the user's own settings name it: “shape ≠ authority” (L437).
- 3.19.0, L148 — A migrated project's old path “no longer registers whatever folder is there later” (L148).
- 3.19.0, L149 — Two projects can no longer share machine-local state.
- 3.19.1, L81 — Per-turn retrieval injects only for registered projects: “a store planted in an unregistered folder injects nothing” (L81).
- 3.19.1, L94 — A close lock cannot be released by the wrong session.
- 3.19.2, L58–L63 — A close receipt counts only for the session, project and harness it names.
- Git, `7e792a1` — The per-turn hook no longer creates a store in a folder that has none. `e2ae3af` — a repo-supplied `CORE_CLOSE_INDEX` is rejected.

### A hostile HOME or environment

- 3.11.0, L441 — “a project-controlled hook environment could point it at an attacker directory” (L441). The home folder now comes from the OS account record. “never released; caught before release” (L441).
- 3.11.0, L434 — The package smoke includes “hostile-environment authority” (L434).
- 3.12.0, L421 — Three env vars “can no longer be used to redirect telemetry writes outside the trusted `~/.core` boundary” (L421).
- 3.14.0, L366 — A personal repo path is taken out of the shared probe descriptor.
- Git, `27212fe` — “every trusted-tree root resolves from the OS-account home” (`27212fe`).

### Links, symlinks and special files

- 3.12.0, L421 — The log-file variable is “hardened against symlink bypass” (L421).
- 3.17.2, L179 — A symlink or junction inside the store is recorded as skipped.
- 3.19.0, L156 — Migration stops on a symlink in the old workspace. Before, it “was followed and its target copied into the project” (L156).
- 3.19.1, L116 — The link-refusal tests run on Windows through a junction.
- 3.19.2, L60, L64 — Purge refuses a linked `_metrics`. A linked machine-local folder is reported and nothing in it is deleted.
- 3.20.0, L52 — “Links, extra hard links, pipes and devices are refused before CORE opens its own state files” (L52).

### Signatures and the install secret

"Install secret" is not a changelog term. The mechanism appears in these entries:

- 3.19.0, L143 — The metrics storage pin “is now signed by this install” (L143).
- 3.19.0, L139 — The pin's signature covers its project. A copied pin is refused.
- 3.19.0, L157 — A migration receipt “is now signed by the install that wrote it” (L157).
- 3.19.2, L59 — Adoption no longer re-signs a carried bootstrap record “under this install's key” (L59).
- 3.20.0, L33 — After the folder rename, “the signed records in it keep verifying” (L33).
- 3.20.0, L35 — The account folder keeps only “the project list and the install's identity” (L35).
- 3.20.0, L39 — Metrics packages use a per-project pseudonym key.
- Git, `6c729f7` — A signed control file that git tracks is not trusted. A failed git call now reads as "tracked".
- Source — The secret is a file, `~/.core/install-secret`. It keys an HMAC over path, harness and install id (`scripts/project-state.mjs:17-18`).

### Project-only mode and restrictive mode

- 3.20.0, L44 — “Project-only mode.” (L44) The two commands “run CORE from the project folder alone and touch nothing outside it” (L44). Automatic retrieval and capture are off. Outside evidence is “reported as not observed” (L44).
- "Restrictive mode" is not a changelog term. In the source it is the module behind project-only: “project-only is the one restrictive mode today” (`scripts/restrictive-mode.mjs:9`).

### Publishing consent

- 2.2.0, L888 — Push policy is per user and per repo. The default is to confirm every push.
- 3.14.0, L349 — A memory page is published only on a go-ahead each time, private by default, “never at startup/close/scheduled” (L349).
- 3.14.0, L348 — Changed in the same release to narrate and proceed. Still ask first for “anything carrying another party's data or content the user has flagged sensitive” (L348).
- 3.14.0, L347 — The CLI refuses to record a private publish without consent fields.
- 3.14.0, L359 — Every publish outcome gets its own receipt. Revocation is stamped.
- 3.16.1, L245, L260 — The live republish loop needs consent first: “an explicit consent basis is required before the loop can arm” (L245).
- 3.18.0, L165 — With memory writes left to the agent: “Pushes and destructive or external writes keep their own gates.” (L165)

### Untrusted content

"Untrusted" is not a changelog word. The nearest entries:

- 3.10.0, L461 — A user's edit to `PROJECT.md` beats any CORE write: “a between-session user edit always wins” (L461).
- 3.11.0, L433 — A safety battery of wrong, conflicting, stuffed and retired memories.
- 3.11.0, L442, L446 — A retired unit can no longer come back through a stale cache.
- 3.15.0, L298 — Prose evals plant “embedded injection markers that must not be followed” (L298).
- 3.18.0, L169 — The canary is removed because an instruction in injected memory “looks exactly like a prompt injection” (L169).
- 3.19.1, L81 — A planted store injects nothing.

### Privacy, capture and export

- 3.4.0, L582 — Metrics sit “behind a privacy gate” (L582), off by default.
- 3.6.0, L546 — On by default. “nothing leaves your machine” (L546).
- 3.11.0, L432 — The export is built from a whitelist and scanned: “any hit refuses the export (exit 2)” (L432).
- 3.13.0, L392 — That scanner had two bypasses and could leak an identifier prefix.
- 3.14.0, L326 — Turn capture stores each prompt and the context delivered. Local, owner-only, on by default. “The exporter has no read path into it” (L326).
- 3.14.0, L341 — A sensitive capture switch is per user, so it “can never ride along to a teammate” (L341).
- 3.14.0, L351; 3.15.0, L313–L314 — First-run disclosure. It reaches every project and shows either way.
- 3.14.1, L319; 3.15.0, L288 — Internal narrative scrubbed from the public repo, including “a tenant company name” (L319).
- 3.19.0, L141, L150–L151 — The notice stops promising a deletion. Two opt-outs survive adoption.
- 3.19.1, L77 — The automatic close stored prompt text with capture off. Fixed.
- 3.19.1, L79–L80 — The notice admits a synced folder syncs the log. Purge covers the full-text log.
- 3.19.1, L86 — With metrics off, maintenance writes no metrics.
- 3.19.1, L109 — The worksheet that holds raw turn text is moved out of the project's `_metrics/`.
- 3.20.0, L38 — Telemetry and working files are git-ignored from their first write.
- 3.20.0, L51 — An opt-out file that cannot be read keeps capture off.
- 3.19.2, L60 — Purge is contained. Stated limit: “CORE does not defend against a concurrent same-user process racing the filesystem” (L60).

### Running unattended

- 3.9.0, L486 — Unattended maintenance is gated. Still not built in 3.20.1 (`protocols/hygiene.md:155`).
- 3.10.0, L464 — The background close strips API keys, “so an unattended close doesn't surprise-bill an API key” (L464).
- 3.15.0, L301 — The background close stops running a model at all.
- 3.19.0, L130; 3.19.1, L85 — Nothing is deleted on a schedule. Maintenance never deletes.

### Multi-agent anchoring

- 2.8.0, L744, L755; 3.3.0, L613; 3.4.0, L600 — The anti-anchoring rule on Claude Code rests on trust. It is reported as degraded and its output is advisory.

---

## 7. Ten lessons for a rewrite

Each is tied to entries above.

**1. Do not work out where the harness keeps things. Be told, or say you do not know.**
Seven fixes went to the rule that names the harness's project folder (L625, L596, L521, L493, L393, L226–L236, L106). None of them questioned the tree it sits in (3a). The transcript was read for the wrong session twice (L518, L93). A computed path that is wrong still returns something: an empty read.

**2. "Could not read" is an answer of its own. It is never zero.**
Unreadable calibration showed as zero (L50). Permission denied read as absent (L64). A unit that could not be read dropped out and health “stayed clean” (L100). A wrong folder gave “a clean result” (L138). In 3.20.1 a missing file still prints `CONTEXT-COMPLETE` (2.7, row 2).

**3. A status word is not evidence. A receipt must carry what it claims.**
A receipt suppressed a close “on its status alone” (L58). A close was certified with zero ops recorded (L395). A failed run was stamped closed because nobody read its exit status (L474). A finished receipt marked data migrated “without being copied” (L145). Each fix added evidence to the record: the session, the project, the inner record, a signature.

**4. Quiet and exit 0 are fine only when a receipt proves the check ran.**
Hooks must exit 0 (L310). The same hook was later fixed for exiting 0 with no trace (L24). “Healthy → total silence.” (L331) had to be followed by a fix so the chain could “detect its own silence” (L311). The rule that survives both: a failure may be quiet to the user, never to the record.

**5. Keep generated text out of files a person edits, and out of what you hash to detect change.**
Writing link blocks into unit files needed a stamp cache, an outside-the-block hash and a refusal rule, and still laundered user edits once (L364) and confused a stamp once (L394). Four entries are about CORE's own drift log tripping CORE's own checks (L708, L668, L629, L23). In 3.20.1 its own decoration re-owes a render (3f).

**6. One owner for each rule. Copies drift.**
The slug rule, the store walk and the entry guard were each fixed three to seven times in different files (2.5). A `retired` unit slipped through because each script had its own status list (L507). The entry guard stopped recurring only when it became one helper with a test that keeps new scripts on it (L250–L251). 34 of the 132 rows are this.

**7. No writer without a reader.**
A trace format ran two months unread (L372). A file was “written every close and read by nothing” (L303). A command's output was never read back (L199). A pipeline “could only” (L264) record unknowns. A capture stream could only fire when there was nothing to capture (L370). All were built first and deleted later. The first check for any instrument is: who reads this, and when?

**8. Name a thing for what it proves, and build the claim from the code.**
One verdict covered things nothing measured (L353). An export called "efficacy" established no benefit (L291). A "hard cap" never capped (L835). Docs said “no hooks” for two releases after hooks shipped (L448). A privacy notice promised a deletion that had stopped (L141). The fix that held was a guard that fails when a count or claim drifts from the tree (L296).

**9. A check counts only after someone has seen it fail, on every platform it claims.**
24 Windows bugs shipped on a CI leg that “had never run clean” (L521). A fixture “had no edges, so the suite couldn't see this class” (L445). A test swallowed its own assertion (L119). Gated tests skipped and stayed green (L252). The later habit is the right one: fixes “each with a mutation-checked test” (L103), and falsifiers planted to prove a guard fires (L288).

**10. A harder gate with no "unknown" state trades missed failures for false alarms.**
Every Windows install was `unknown`, so every write gate closed (L654). Any validator warning blocked startup (L628). A new stamp rule flagged every unit in an older store (L307). The release gate refused a good stamp (L70). Each was a correct idea, fail closed, applied where the honest answer was "cannot tell yet". The changelog has 27 false alarms in all (group I).

---

## Appendix — What I did not verify

- **Commit bodies.** I read all 699 subjects and about 30 bodies. Other bodies may hold more instances of the class, or contradict a changelog line.
- **Changelog against code, release by release.** I took each changelog entry at its word. I did not check out old releases to confirm that a bug existed or that a fix landed.
- **A second config tree.** I did not run any script with `CLAUDE_CONFIG_DIR` set. Section 3a's result table is read from the code.
- **The decoration loop end to end.** I applied the link block with the product's own function and ran the product's own detector. I did not run `decorate-graph.mjs` itself, a real startup, or a real close.
- **Rows 6 to 16 of Section 2.7.** Read from source, not run.
- **The test suite, CI, and any hook in a live harness.** Not run.
- **Windows and Codex behavior.** Everything here is from text. Nothing was run on either.
- **Dates.** Changelog dates and git dates differ by a day for some releases. I report both and did not reconcile them.
- **The grouping in Section 2.** One group per row is a judgment. Another reader would move some rows between "wrong place" and "empty read as zero", or between "inverse" and "stale marker". The totals would shift by a few. The order of the top three groups is close: 25, 24, 20.
- **History before 2026-05-20.** Not in this clone.

## Appendix — The five runs

All read-only against the repo. Scratch files lived outside it. After each run I confirmed `git status` was unchanged and no `~/.core` folder had been created.

1. `node plugins/core/skills/core/scripts/check-context-integrity.mjs --harness claude-code --cwd /nonexistent-project-xyz --project /nonexistent-project-xyz/PROJECT.md --project-read-lines 0` → `CONTEXT-COMPLETE`, exit 0.
2. `node plugins/core/skills/core/scripts/metrics-tripwires.mjs /nonexistent-project-xyz` → no output, exit 0. Same on a scratch store with no metrics.
3. `node plugins/core/skills/core/scripts/maintenance-run.mjs <scratch> --dry-run` → `Kept memory current: regenerated indexes + summary index.`, exit 0. With `--json`: `"ranOps":["decisions-index","risks-index","summary-index"]`. Files before and after: the one unit file only.
4. `node plugins/core/skills/core/scripts/read-transcript.mjs --harness claude-code --transcript /nonexistent/x.jsonl` → no output, exit 0.
5. On a two-unit scratch store: write a `closed` marker carrying `computeSourceSignature()`; `close-pass.mjs detect … --json` → `{"state":"closed","owed":[]}`; apply `decorateUnitText()` to one unit; `detect` again → `{"state":"owed","owed":["render-project-md"],"reason":"store-changed"}`.
