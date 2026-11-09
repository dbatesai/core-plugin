# How CORE tests and measures itself today

Source under review: CORE 3.20.1, commit `79b526b`, at `/home/user/core-plugin`. Read on 2026-11-09.

**Purpose.** A rewrite should inherit the evaluation approach, not rediscover it. This file says what exists, what each part proves, and where it can lie.

**Rules I followed.** Repo files only. No web. No memory. Each claim carries a `file:line` citation or the output of a command I ran. Paths are relative to the repo root. Two shorthands and one convention:

- `SC/` means `plugins/core/skills/core/scripts/`
- `TS/` means `tests/scripts/`
- A bare `:N` continues the file cited just before it in the same sentence, bullet or table cell.

**What I ran.** Eighteen small experiments. Labels run E1 to E20; E7 and E13 are not used. Each ran with a temporary HOME, from a temporary folder, with CORE's account home steered to the same temporary folder by the repo's own test preload (`tests/helpers/account-home-preload.mjs:7-11`). Appendix B lists them with their output. After the runs, `git status --short` showed changes only under `gauntlet/` (this file's folder, which other work in this run also writes to), no cache files had appeared in `tests/fixtures/`, and `/root/.core` did not exist.

**What I did not do.** I did not run the whole test suite. I ran `node --test` on three small test files only. Local Node is v22.23.4; CI pins Node 24 (`.github/workflows/ci.yml:20`, `:290`).

**What I read in full.** `tests/prose-evals/*`, `tests/acceptance/*`, `tests/fixtures/*`, `tests/smoke/*`, `tests/helpers/*`, `tests/isolated-controls/*`. The 16 measurement scripts named in the brief. `plugins/core/skills/metrics/SKILL.md`, `plugins/core/skills/core/protocols/validation.md`. `docs/*.md`, the three workflows, `.github/scripts/*`, `scripts/release/*.mjs`. These 51 test files: prose-eval, self-test-round, scorecard, retrieval-harness, retrieve-precision, retrieval-premise, hindsight-judge, all 20 `metrics-*` tests, calibrate-classifier, calibration-readonly, calibration-output-preservation, classify-turns, analyze-retrieval-quality, analyze-retrieval-skip, audit-memory-boundary, validate, adversarial-run-gate, turn-capture, incomplete-retrieval, check-context-integrity, capability-probe, orphan-detector, probe-itself-validation, shipped-surface-inventory-guard, startup-doc-contract, cli-entry-convergence, dev-leakage-guard, obligation3-ladder, policy-safety, guard-consolidation, guard-read-invariants, fixture-cold-clean. Also two helper modules: the leak scanner and `trusted-test-tmp.mjs`.

**What I read in part.** refocus-doc-guard (most of it). For the other 124 test files in `tests/scripts/` I read the header comment and the test titles only.

---

## 1. The evaluation approach in one page

CORE checks itself in layers. Each layer answers a different question. Most layers ask "does the machinery behave?". Two ask "is retrieval good?". None asks "does memory help the user?". That last question was removed from scope on purpose (Section 2.8).

| Layer | The question it answers | Where it lives | Model call | Where it runs |
|---|---|---|---|---|
| Unit tests | Does each script keep its contract, including on missing, corrupt or hostile input? | `TS/*.test.mjs`, 176 files | No | CI, Linux and Windows (`.github/workflows/ci.yml:274-309`) |
| Regression guards | Did a known defect pattern come back? | `TS/guard-*.test.mjs` and others; map in `docs/regression-guards.md:9-15` | No | CI |
| Doc-contract guards | Do docs and shipped tree agree? Does protocol prose still say what a past defect required? | `TS/*-doc-guard.test.mjs`, `TS/startup-doc-contract.test.mjs`, `TS/shipped-surface-inventory-guard.test.mjs` | No | CI |
| Fixtures and gold sets | Does retrieval resist known traps? | `tests/fixtures/` | No | CI, through tests |
| Retrieval harness | For questions with known answers, how often is the right unit in the top K? | `SC/retrieval-harness.mjs` | Optional | On demand; inside self-test and `/metrics full` |
| Blind self-test rounds | Can memories be found from questions written by someone who never saw the search code? Did the score move between rounds? | `SC/self-test-round.mjs`, `plugins/core/skills/metrics/SKILL.md:80-93` | The author is a model | On demand; newest round re-graded each maintenance pass |
| Hindsight judging | After the fact, did the delivered context match what the same search returns for the full prompt? | `SC/hindsight-judge.mjs` | No | Each maintenance pass |
| Scorecards and tripwires | What did we conclude last time? Did it get worse? | `SC/scorecard.mjs`, `SC/metrics-tripwires.mjs` | No | Maintenance pass; session start |
| Recognition classifier and calibration | Did the agent ask for something it already had? Can that classifier be trusted yet? | `SC/classify-turns.mjs`, `SC/metrics-rollup.mjs`, `SC/calibrate-classifier.mjs` | Labelers are agents (`SC/calibrate-classifier.mjs:12-13`) | `/process-memory` |
| Prose evals | Does a `/refocus` answer or a finalize summary keep obligations, ignore injected instructions, and avoid unsupported "all done" claims? | `tests/prose-evals/` | No | CI, but only against canned answers |
| Smoke | Do the hooks work from a package built from committed files? Does the previous release still read a store this one wrote? | `tests/smoke/source-package-smoke.sh` | No | CI (`.github/workflows/ci.yml:311-328`) |
| Acceptance packet | In one-folder mode, does any entry point touch anything outside the folder? | `tests/acceptance/one-folder-packet.mjs` | No | On demand only |
| Release gates | Is the tag going on a commit whose CI passed, with a correct source stamp and a version bump? | `.github/workflows/auto-tag.yml`, `version-check.yml`, `scripts/release/` | No | CI |
| Manual review prompt | Does this change repeat one of five known defect patterns? | `docs/change-review-prompt.md` | Yes, a fresh agent | Manual |

### 1.1 Unit tests

- 176 test files, 40,223 lines (`wc -l tests/scripts/*.test.mjs`).
- The runner is plain `node --test` (`scripts/release/run-suite-isolated.mjs:84`). No test framework. The repo tracks no `package.json` (`git ls-files | grep -c package.json` prints 0).
- The suite runs under an isolated account home. `scripts/release/run-suite-isolated.mjs:44-45` globs `tests/scripts/*.test.mjs`. It first runs three controls and stops if any fails (`:56-81`): the preload resolves the disposable home; a write into the protected `~/.core` is refused; the test root still takes writes.
- A second guard snapshots the real `~/.core` before the suite and fails if it changed (`scripts/release/real-home-guard.mjs:22-50`, `.github/workflows/ci.yml:292-309`).
- Appendix A lists all 180 files in `tests/scripts/` by subject.

### 1.2 Guards

`docs/regression-guards.md:9-15` names five defect patterns and the guard for each.

| # | Pattern | Guard | State |
|---|---|---|---|
| 1 | Prose obligations the agent will not reliably run | None | "manual for now" (`docs/regression-guards.md:11`) |
| 2 | Fixed once, never swept | `TS/guard-consolidation.test.mjs` | Ratchets: a copy count may not grow (`:38-63`) |
| 3 | Instruments report healthy while recording nothing | No dedicated file | "per-instrument tests; add as found" (`docs/regression-guards.md:13`) |
| 4 | Soft trust boundaries | `TS/retrieve-stray-write.test.mjs`, `TS/close-index-path-validation.test.mjs` | Tests |
| 5 | Read-side invariant with no single owner | `TS/guard-read-invariants.test.mjs` | One fixture checked against seven readers (`:56-64`) |

Pattern 3 is the defect class the rewrite must kill. Today it has no single guard. Section 6 shows it is still live.

### 1.3 Fixtures and gold sets

All fixtures are tiny hand-written stores. Tests copy them to a temp folder first. A guard fails if a checked-in fixture gains cache files (`TS/fixture-cold-clean.test.mjs:41-47`).

| Fixture | Contents | Designed to catch | Used by |
|---|---|---|---|
| `tests/fixtures/obligation3-store/` | 7 units: 6 active, 1 retired | A four-rung difficulty ladder: literal, category, value, cross-domain (`TS/obligation3-ladder.test.mjs:17-22`). A pure-noise distractor (`distractor-coffee-grinder.md`). A retired unit that must never surface (`distractor-retired-rolex.md`). | 17 test files (`grep -l obligation3-store tests/scripts/*.test.mjs`), for example `TS/retrieve-precision.test.mjs:9`, `TS/self-test-round.test.mjs:10`, `TS/retrieval-harness.test.mjs:10` |
| `tests/fixtures/nested-store/` | 7 units: 6 top-level, 1 nested two folders down | Nested units are indexed. A unit reachable only by an edge still surfaces. The fixture checks itself: the neighbor must share no query word (`TS/retrieval-premise.test.mjs:88-91`). Stale-cache and restored-timestamp attacks (`:99-113`). | `TS/retrieval-premise.test.mjs:20`, `TS/retrieve-hook.test.mjs:99`, `tests/smoke/source-package-smoke.sh:24` |
| `tests/fixtures/tier-safety-store/` | 5 units and a gold set of one query (`tests/fixtures/tier-safety-store/_tests-goldset.json:1`) | A retired "poison" unit with the strongest query words. It must not surface under any tier policy. The test calls itself "NON-TAUTOLOGICAL": the poison unit is present at the stage under test (`TS/retrieval-premise.test.mjs:172-192`). | `TS/retrieval-premise.test.mjs:23` |
| `tests/fixtures/policy-safety-store/` | 10 units | Distractors at the policy stage: active-but-wrong, conflicting, vocabulary-stuffed, invalidated, retired (`TS/policy-safety.test.mjs:1-17`). Two tests pin known weaknesses instead of hiding them: "CHARACTERIZED" (`:62-75`) and "PINNED recall reality" (`:93-100`). | `TS/policy-safety.test.mjs:27` |
| `tests/fixtures/fake-reasoner.mjs` | 13 lines | A stand-in for the external reasoner command. It prints the picks named in an env var and logs the prompt it received (`:5-13`). | `TS/retrieval-harness.test.mjs:247-304` |
| `tests/prose-evals/fixtures/*.json` | 2 scenarios | See 1.7 | `TS/prose-eval.test.mjs` |

Gold data in the repo is small. One file with one query (`tests/fixtures/tier-safety-store/_tests-goldset.json:1`). Ten inline queries (`TS/retrieve-precision.test.mjs:24-35`). Four ladder hooks (`TS/obligation3-ladder.test.mjs:17-22`). A few inline sets in tests.

### 1.4 Retrieval harness

- It scores each "arm" on one frozen copy of the store: Recall at K for K in 5, 10, 30, 100, MRR, and a forbidden-unit rate at depth 10 (`SC/retrieval-harness.mjs:57-58`).
- Arms: `lexical` (the older baseline), `ranking` (the product ranker before edge expansion), `context3` (the top 3 actually delivered), `bm25`, `escalated` (needs an external reasoner) (`SC/retrieval-harness.mjs:114-131`).
- It calls the shipped functions, not a copy (`SC/retrieval-harness.mjs:4-8`, `:50`).
- It refuses a weak answer key. Empty set, missing rung, duplicate ids, or an id both expected and forbidden all throw (`SC/retrieval-harness.mjs:329-375`).
- It measures one captured snapshot. Two "falsifier" tests prove that changing or locking the files after capture changes nothing (`TS/retrieval-harness.test.mjs:147-208`).
- Every run emits a manifest: plugin version, commit, hashes of the harness, the gold set, the product functions and the store (`SC/retrieval-harness.mjs:181-225`).

### 1.5 Blind self-test rounds

See Section 2. In short: a script freezes the store identity and writes a brief. A fresh model writes about 12 questions from the stored facts only. The script checks the set mechanically, freezes it, and runs the harness on it.

### 1.6 Hindsight judging, scorecards, tripwires

- Each turn, the retrieval hook saves the prompt and the delivered context to a local evidence file (`plugins/core/skills/core/protocols/data-storage.md:395`).
- At each maintenance pass, the judge grades up to 50 unjudged turns (`SC/maintenance-run.mjs:163-177`). Verdicts: `hit-right`, `hindsight-miss`, `noise`, `storage-gap`, `drift-invalidated` (`SC/hindsight-judge.mjs:18-31`).
- The same pass pins one scorecard row when new grades or self-test rows exist (`SC/maintenance-run.mjs:183-200`).
- At session start a tripwire script reads the pinned rows and prints one line per problem, or nothing (`SC/metrics-tripwires.mjs:5-8`, `plugins/core/skills/core/protocols/startup.md:483-488`).
- The maintenance pass runs at session start, `/finalize` and `/process-memory` (`SC/maintenance-run.mjs:246-248`).

### 1.7 Prose evals, exactly

**What a scenario is.** A JSON file with a story and machine-checkable plants (`tests/prose-evals/fixtures/refocus-scenario.json:1-12`). Fields: `word_cap`, `required_sections`, `planted_obligations` (strings that must survive), `planted_threads` (earlier threads that need a status), `injection_markers` (a token an embedded instruction asks for; it must not appear), `forbidden_claims`, and a free-text `scenario`. There are two scenarios: one for `/refocus`, one for the finalize summary.

**What a candidate is.** A hand-written markdown answer checked in as a file. There are five: `refocus-a.md` (good), `refocus-b.md` (follows the injection, drops obligations), `refocus-c.md` (tidy but drops an obligation), `finalize-a.md` (honest partial), `finalize-b.md` (claims all green) (`tests/prose-evals/candidates/`). Candidates are not produced by a model at eval time.

**Who the judge is.** A deterministic function, `checkProseOutput(fixture, text)` (`tests/prose-evals/prose-eval.mjs:82-154`). No model. It runs nine checks: `lost-obligation`, `injection-followed`, `missing-section`, `empty-section`, `over-cap`, `no-provenance`, `no-effect-label`, `thread-unaccounted`, `forbidden-claim` (`:11-20`). It also catches a paraphrased "everything is done" claim with two word lists (`:65-80`, `:145-151`).

**Is it blind?** Only in a narrow sense. The function takes the text and the fixture. It is not told which candidate it got (`tests/prose-evals/prose-eval.mjs:26-27`). Nothing is shuffled. Nothing is hidden from anyone. The expected verdict for each candidate sits in the test file (`TS/prose-eval.test.mjs:13-14`, `:16-49`).

**The "blind reviewer".** The file header says the judgment half "is scored by a blind reviewer using the same fixtures" (`tests/prose-evals/prose-eval.mjs:6-8`). I found no script, protocol or doc for that reviewer. A repo-wide search for "blind reviewer" matches that one line only.

**How scores are produced.** `{ verdict: 'pass' | 'fail', failures: [{check, detail}] }`. Pass only if every check passes (`tests/prose-evals/prose-eval.mjs:153`). No numeric score.

**How it is run.** Only through `TS/prose-eval.test.mjs`, inside the normal suite. `prose-eval.mjs` has no CLI. No shipped skill calls it; the only references are in `tests/` (repo-wide search for `prose-eval`).

**What it costs.** No model calls. My run: the 7 prose tests passed inside a 15-test run that took 0.18 seconds (Appendix B, T1).

**Does it run in CI?** Yes, as part of the suite glob (`scripts/release/run-suite-isolated.mjs:45`).

**What it proves.** That the checker catches the planted failures in five canned answers. It does not score any real `/refocus` or `/finalize` output. A separate guard checks that the `/refocus` skill text names the same sections, effect labels, statuses and provenance prefixes (`TS/refocus-doc-guard.test.mjs`, tests REF-02 to REF-05).

### 1.8 Smoke

`tests/smoke/source-package-smoke.sh` runs in CI.

- It builds the package with `git archive HEAD:plugins/core`, so an untracked file cannot fake a pass (`tests/smoke/source-package-smoke.sh:2-7`, `:44-46`).
- It says what it does not prove: that an installed cache carries this build (`tests/smoke/source-package-smoke.sh:9-13`).
- It checks, all in `tests/smoke/source-package-smoke.sh`: no `tests/` in the package (`:58-59`); the SessionStart hook injects `/core` (`:65-66`); a hostile HOME cannot redirect the first action (`:68-72`); the retrieval hook finds a nested unit and keeps its tier label (`:79-81`); no store means no output and no files (`:84-86`); the close hook loads and honors its kill switch (`:89-90`).
- Rollback leg: this version writes an index; the immediate-prior release reads it; this version reads it again (`tests/smoke/source-package-smoke.sh:92-138`). An empty answer fails: "a release that retrieves nothing has not demonstrated compatibility, only survival" (`:116-117`). No prior tag also fails (`:109-110`).
- It prints its own sha256 so a receipt can pin the procedure (`tests/smoke/source-package-smoke.sh:25-26`).

`tests/smoke/in-project-state-installed-proof.sh` is not in CI (no workflow names it). It drives the state migration from a packaged copy against a sandbox HOME: copy faults, a held lock, forged, truncated and git-tracked receipts, a forged destination, and an old-new-old-new round trip (`tests/smoke/in-project-state-installed-proof.sh:6-10`). With `PROOF_PKG` it first checks the installed root is byte-identical to the committed package and stops if not (`tests/smoke/in-project-state-installed-proof.sh:38-48`).

### 1.9 Acceptance packet

`tests/acceptance/one-folder-packet.mjs` proves one thing: in one-folder ("project-only") mode, no entry point reads or writes outside the project.

- Every entry point runs as a child under a file-access gate (`tests/scripts/fs-confine.mjs:1-14`), twice: outside paths answer "unreadable", then "absent" (`tests/acceptance/one-folder-packet.mjs:5-8`, `:81`).
- Each row is judged twice: confinement, and outcome (exit code, reported state, material effect) (`tests/acceptance/one-folder-packet.mjs:10-11`, `:85-105`).
- A row with no stated expectation fails: `'row has no outcome expectation'` (`tests/acceptance/one-folder-packet.mjs:100`).
- Four negative controls must each produce a violation. A control that stays quiet fails the packet: `'FAIL (control did not trigger)'` (`tests/acceptance/one-folder-packet.mjs:186-210`).
- A run that cannot name its own commit fails (`tests/acceptance/one-folder-packet.mjs:34-36`, `:212`).
- Unsupported paths are run anyway and recorded as observed, not claimed (`tests/acceptance/one-folder-packet.mjs:126-128`).
- The receipt states the gate's limit: "Node fs seam; child processes, native code and a real sandbox are outside it" (`tests/acceptance/one-folder-packet.mjs:213`).
- It is not in CI. No workflow or test references it (repo-wide search for `one-folder-packet` finds only the file itself).

### 1.10 Helpers and controls

- `tests/helpers/account-home-preload.mjs:7-11` makes every process in a run resolve a chosen account home.
- `tests/helpers/account-home.mjs:3-16` does the same for one child or in-process.
- `tests/helpers/disposable-home.mjs:7-14` returns true only for the runner's own temp home, so a control cannot damage a real folder.
- `tests/isolated-controls/` holds four control tests for the isolated runner: a stray write that must fail (`tests/isolated-controls/stray-write.control.mjs:8-10`), a stray write from a spawned process (`tests/isolated-controls/child-stray-write.control.mjs:7-12`), a write that must succeed (`tests/isolated-controls/test-root-write.control.mjs:7-9`), and a forced cleanup failure (`tests/isolated-controls/cleanup-failure.control.mjs:9-17`). `TS/run-suite-isolated.test.mjs:12` drives them.

### 1.11 Release gates

- CI `validate` job, 12 steps: syntax check, lint, manifest JSON, hook schema, required fields, version lockstep, marketplace paths, frontmatter, import every script, markdown links, doc skill names (`.github/workflows/ci.yml:22-272`). Two steps fail if their file glob matches nothing: "script glob matched zero files — path moved?" (`:27`, `:188`).
- Version check on pull requests: versions in lockstep, bumped against the real base branch, changelog section present (`.github/workflows/version-check.yml:18-77`).
- Auto-tag: a tag is issued only after CI succeeded for that exact commit (`.github/workflows/auto-tag.yml:66-73`) and the embedded source stamp checks out (`:86-90`).
- `.github/scripts/require-green-candidate.mjs:19-22` uses three exit codes: 0 green, 1 not green, 2 no run or unreadable payload.
- `scripts/release/verify-release-identity.mjs:29-33` uses four: 0 holds, 1 mismatch, 2 "indeterminate ... never treated as a pass", 3 stale.
- A `/cut-release` flow is named as a gate in several places (`TS/dev-leakage-guard.mjs:15`, `plugins/core/skills/core/references/architecture-doctrines.md:23`, `:61`). It is not in this repo. I could not check it.

---

## 2. Blind evaluation as it exists today

### 2.1 What is blind

Three things use the word. Only the first is a real attempt at a blind test.

**(a) Self-test question authoring.** The author must not see the retrieval code or run any search tool.

- The brief says so: "You may READ unit files only. You may NOT run any retrieval, search, or scoring tool" (`SC/self-test-round.mjs:295-299`).
- The author is "a fresh subagent whose entire prompt is the brief verbatim plus the active unit bodies" (`plugins/core/skills/metrics/SKILL.md:88`).
- The blindness is not enforced. The script says it "CANNOT prove the author was blind". It only checks that an attestation string is present (`SC/self-test-round.mjs:24-28`, `:386-389`).
- A different model family is preferred "when an alternate CLI is available; when not, say so honestly" (`plugins/core/skills/metrics/SKILL.md:88`). The author model is recorded (`SC/self-test-round.mjs:524-525`).

**(b) Calibration labeling.** Labelers judge turns without seeing the classifier's guess.

- The worksheet leaves out the predicted state. A companion file holds the predictions and a nonce. Each worksheet row carries a sha256 commitment (`SC/calibrate-classifier.mjs:352-391`).
- Import recomputes every commitment and refuses a mismatch (`SC/calibrate-classifier.mjs:485-490`).
- The companion file sits in the same folder. The only barrier is an instruction: "Do not open the sealed predictions companion until labels are final" (`SC/calibrate-classifier.mjs:409`).
- Precision comes from the imported labels only, never from the classifier's own output: "that would be circular" (`SC/calibrate-classifier.mjs:17-18`). A test pins it: unlabeled rows give no precision at all (`TS/metrics-adoption-contract.test.mjs:123-133`).
- Who labels is not pinned down. The stated strategy is "Dispatch N independent labeling agents" (`SC/calibrate-classifier.mjs:12-13`) and the worksheet says "Set `labeler` to your agent name" (`SC/calibrate-classifier.mjs:411`). A test and a comment call the same labels human (`TS/metrics-adoption-contract.test.mjs:121`; `SC/calibrate-classifier.mjs:284`). Import checks that each row lists two or more labelers, an adjudicator and a confidence word (`SC/calibrate-classifier.mjs:497-500`). It does not check that the two labelers differ, or who they are.
- The blind leaks. See gap F1 in Section 6.

**(c) The prose checker.** "Blind" there means the function is not told which candidate it received (Section 1.7).

### 2.2 Who authors the questions

A model subagent, once per round. The script cannot spawn it: "the one thing a script can't do is spawn a genuinely blind author" (`plugins/core/skills/metrics/SKILL.md:82`). The scheduled pass never authors. It stamps a trigger at most once a week and asks for a round at the next user-invoked `/metrics` (`SC/maintenance-run.mjs:202-219`, `SC/self-test-round.mjs:697-701`).

A default round is 12 questions: 2 literal, 3 category, 3 value, 2 cross-domain, 1 temporal, 1 abstention (`SC/self-test-round.mjs:93-100`).

### 2.3 What the machine checks before freezing

`verifyGoldset` (`SC/self-test-round.mjs:372-482`). Every line number in this list is in `SC/self-test-round.mjs`:

- Schema, through the harness's own gate (`SC/self-test-round.mjs:378-384`).
- Attestation and author present (`SC/self-test-round.mjs:386-392`).
- The store has not changed since the round was created (`SC/self-test-round.mjs:394-401`).
- Every answer id exists (`SC/self-test-round.mjs:409-416`).
- Indirect kinds share zero content words with the answer's title, body and topics, after light stemming (`SC/self-test-round.mjs:418-431`, `:163-180`).
- False-premise questions: the swapped entity is absent from the store and the framing entities are present (`SC/self-test-round.mjs:433-457`).
- Per-kind counts: over quota is refused, under quota only warns (`SC/self-test-round.mjs:459-470`).
- A warning if a unit quotes the question verbatim (`SC/self-test-round.mjs:472-479`).

On refusal the set goes back to the author: "never silently patch the set yourself; that defeats the blindness" (`plugins/core/skills/metrics/SKILL.md:89`).

### 2.4 Who grades

A script. No model, no person.

- `run` calls the real harness on the frozen set (`SC/self-test-round.mjs:568-583`).
- The headline is Recall at 10 on the `ranking` arm (`SC/self-test-round.mjs:535-536`). That is the ranker before edge expansion. The product delivers 3 (`plugins/core/skills/core/hooks/retrieve-context-hook.mjs:55-56`).
- The answer key is the author's own `expected` ids. The product says so: "self-authored answer key, directional snapshot", "Never call it a pass/fail gate" (`plugins/core/skills/metrics/SKILL.md:90`).
- The trust label is always `provisional` (`SC/metrics-check.mjs:448-455`, `:490`).

### 2.5 How overfitting is detected: the old-vs-new-round delta

- When a round is run, every earlier frozen round is run too, against the same snapshot of the current store (`SC/self-test-round.mjs:585-601`).
- `delta = this round's headline − mean of the earlier rounds' headlines` (`SC/self-test-round.mjs:602-604`).
- The idea: if old question sets score much better than a fresh one, the store may have been tuned to the old sets.
- It is shown in the run report and in `/metrics full` (`SC/self-test-round.mjs:831-838`, `SC/metrics-check.mjs:478-480`).
- It is skipped on the automatic re-grade (`SC/self-test-round.mjs:562-567`, `:687`).
- No tripwire reads it. The scorecard pins only `headline` and `round_id` (`SC/scorecard.mjs:136-139`).
- Its only test checks that two identical question sets give a delta near zero (`TS/self-test-round.test.mjs:238-260`).
- The explanatory note has the sign backwards. See gap F4.

### 2.6 What "pinned grading history" means

The phrase is in the README (`README.md:47`) and usage guide (`USAGE.md:68`). It means the scorecard log.

- One row per pass, appended to `scorecard-log.jsonl` (`SC/scorecard.mjs:38-40`, `:155-173`).
- Each row holds grade counts, the self-test headline, volumes, capture health, and whether capture was on (`SC/scorecard.mjs:127-151`).
- Each row is stamped with the data window, the producer version and commit, the judge version, and the live tripwire thresholds (`SC/scorecard.mjs:131-134`, `SC/maintenance-run.mjs:186-188`).
- The default `/metrics` view reads these rows, the tripwire state and the capture state. Nothing is recomputed: "no fresh computation, no live re-scoring" (`SC/metrics-check.mjs:872-877`).
- The reason: "a number recomputed on the fly with whatever code is currently installed is not trend-comparable" (`SC/scorecard.mjs:5-12`).
- "Append-only" is a habit of the writer, tested by a prefix check (`TS/scorecard.test.mjs:102-113`). There is no hash chain.

Self-test rounds are pinned too: the question-set sha256, the store snapshot id and a timestamp go in `prereg.json` (`SC/self-test-round.mjs:516-528`). A second register is refused (`:496-499`). The hash is not re-checked when the round is run. See gap A12.

### 2.7 What is not blind

- **The grader.** It is a script, so it does not need to be.
- **The hindsight judge.** It is the same search code grading its own output. The only separation is that it runs later and in another process (`SC/hindsight-judge.mjs:5-16`). See gap F2. The repo names this failure for the classifier, "circular, the R-1 self-confirming failure" (`SC/calibrate-classifier.mjs:17-18`), and tests against it there. The same rule is not applied to the judge.
- **Calibration labelers**, in practice. See gap F1.
- **The prose checker's expectations.** They sit in the test file.
- **Multi-agent review.** CORE rates its own agent isolation as unenforced: "it is TRUST-BASED ... There is no per-agent working-directory isolation ... This row exists to stop that gap from reading as an implicit PASS" (`SC/capability/anti-anchoring-mechanism-probe.mjs:4-10`). Status "always DEGRADED on Claude Code until the isolation mechanism ships (unscheduled)" (`:21`, `:36`).
- **The change-review agent.** It is fresh, not blind: "Run it with a fresh agent, not the one that wrote the change" (`docs/change-review-prompt.md:33`).

### 2.8 Is there a comparison against CORE's absence?

**None found.** The evidence is direct.

- When the benefit row was added, the changelog said: "no matched memory-on/off comparison exists anywhere in this codebase yet" (`CHANGELOG.md:353`).
- The row was later removed: "measuring what the user did with delivered answers is unobservable, so the question left scope by decision rather than by gap" (`CHANGELOG.md:369`).
- The usage guide repeats it (`USAGE.md:69`).
- The export was renamed for the same reason: "nothing in it establishes user benefit" (`CHANGELOG.md:291`).
- Tests now enforce the absence. No "Matched comparison" row, no `benefit` section, no "memory-on/off" sentence (`TS/metrics-check.test.mjs:343-348`, `:410-413`, `:762-763`; `TS/render-metrics-artifact.test.mjs:156`).

A rewrite that adds a with-vs-without comparison will have to delete or replace those assertions.

### 2.9 Is there a comparison against a prior version?

**No quality comparison.** Three partial things exist.

1. A compatibility round trip against the immediate-prior release in the smoke script (`tests/smoke/source-package-smoke.sh:92-138`). It asks "does the old release still answer?", not "is the new one better?". It is not blind.
2. One defect falsifier that builds the tree at an old commit, shows the defect there, and shows it gone at the tip (`TS/close-hook-regression-parent-sha.test.mjs:1-21`, `:32`).
3. Producer version and commit are stamped on every measurement row, because "a score moving between runs must be attributable to store-drift vs ruler-change from the stored record alone" (`SC/self-test-round.mjs:642-645`). Nothing reads those stamps to split a trend. The tripwire compares consecutive cards with no version check (`SC/metrics-tripwires.mjs:70-80`).

The closest thing to an A-versus-B inside one version is the harness's arms. `lexical` is labelled "the pre-T3 baseline" and is printed beside the product ranker (`SC/retrieval-harness.mjs:11`, `:115`). Labels are visible. It is not a no-memory baseline.

---

## 3. Per-instrument table

Exit codes come from the code and, where marked "(ran)", from my own runs in Appendix B. In both tables of this section, a bare `:N` is a line in that row's own instrument file.

| # | Instrument | Question it answers | Input | Verdict words | Missing or unreadable input: what happens, exit code | Model call | Where it runs |
|---|---|---|---|---|---|---|---|
| 1 | `SC/self-test-round.mjs` | Can stored memories be found from questions written blind? Did the score move across rounds? | `_memories/`; round folder `_tests/self-test/round-N/` (`:33-40`); earlier rounds; self-test log; retrieval log for quota | "REGISTERED and FROZEN", "REGISTRATION REFUSED"; headline %; per-kind R@10; "trap-leak rate"; "old-vs-new delta"; status `frozen`, `unregistered`, "corpus DRIFTED", "never run" (`:870-895`). No pass or fail. | No store: `error: no _memories/ store`, exit 1 (`:256-258`, `:901-904`). Round not created or not registered: error, exit 1 (`:493-495`, `:572-574`). Violations: refused, exit 1 (`:864-868`). `status` with no rounds: "no rounds yet", exit 0 (`:889`). Bad usage: exit 2 (`:847-850`). An earlier round that fails to load is skipped silently (`:597-600`). | None in the script. The author is a model. | On demand. Newest round re-graded each maintenance pass (`SC/maintenance-run.mjs:257-267`). Read by `/metrics full`. |
| 2 | `SC/retrieval-harness.mjs` | For a gold set, how often is the right unit in the top K, and how often does a forbidden unit surface? | Store path; gold JSON, default `<store>/_tests/retrieval-gold-set.json` (`:487`) | R@5/10/30/100, MRR, forbid@10, per-rung R@10; "(no reasoner configured)", "arm unavailable" (`:305`); sweep bands (`:461-464`) | No store argument: usage, exit 2 (`:485`). Gold file missing: stderr, exit 1 (`:488`). Empty or invalid gold: uncaught error, exit 1 (ran, E8g, E8h). **Store path missing or empty: full table of 0.00, exit 0 (ran, E8b, E8c).** | None by default. Optional external reasoner command for one arm (`:130-132`, `:229-252`). | On demand. Inside self-test runs and `/metrics full`. |
| 3 | `SC/hindsight-judge.mjs` | Does the delivered set match what the same search returns for the full prompt? | Evidence rows `turn-capture/<date>.jsonl`; live store; judgment log | `hit-right`, `hindsight-miss`, `noise`, `storage-gap`, `drift-invalidated` (`:18-31`); `grade: 'mechanical'` (`:152`) | No evidence, or unreadable files: `{"judged":0,"skipped":0,"verdicts":{}}`, exit 0 (`:71-81`; ran, E1c). Rows without a prompt: counted in `skipped` (`:123-125`). Write failure: `error` field, exit 2 (`:177-179`, `:196`). No argument: usage, exit 1 (`:188-191`). | No (`:15-16`) | Each maintenance pass, up to 50 rows (`SC/maintenance-run.mjs:166`) |
| 4 | `SC/scorecard.mjs` | What do we conclude for this period, pinned so it can be compared later? | Judgment log; self-test log; retrieval log; evidence files; capture health; earlier cards | A JSON row. `--pin` prints `{"pinned":true|false,"reason":...}` | Absent inputs become nulls and zeros by design (`:17-19`). Unreadable files "contribute nothing" (`:46-56`). Nothing new: `{"pinned":false,"reason":"nothing-new"}`, exit 0 (`:207-209`; ran, E1d). Corrupt log on `--latest`: `[]`, exit 0 (ran, E12c). Pin write failure: exit 2 (`:213-214`). No argument: exit 1. | No | Maintenance pass (`SC/maintenance-run.mjs:183-200`) |
| 5 | `SC/metrics-tripwires.mjs` | Did a pinned conclusion get worse? Is the recorder dead? | Up to 5 newest cards; capture health | One plain line per tripped wire: `self-test-drop`, `self-test-low`, `miss-trend`, `storage-gap-recurrence`, `capture-failure`, `capture-dead`, `capture-disabled`, `capture-coverage`, `scorecard-stale`. Healthy is silence (`:5-8`). | **No cards, a corrupt card log, or a project path that does not exist: prints nothing, exit 0** (`:60-67`; ran, E1a, E12a, E12d). No argument: usage, exit 1 (`:211-214`). | No | Session start (`plugins/core/skills/core/protocols/startup.md:483-488`); inside the `/metrics` default view |
| 6 | `SC/metrics-check.mjs` | Default view: three plain answers from pinned cards. Full view: do the mechanics work, how is retrieval, are the instruments ready? | Default: cards, tripwires, capture state. Full: a scratch store it builds, this store, logs, calibration state, newest round or gold set | Heading `MECHANICS: HEALTHY`, `HEALTHY — with caveats`, `DEGRADED`, `MACHINERY WORKING, NO STORE` (`:627-632`). Trust labels (`:153-156`). Default view: `YES`, `MOSTLY`, `NO`, "not yet measured", "not measured", "too little evidence yet", "UNREADABLE", "UNKNOWN, not all-clear" (`:947-1019`). | "Exit 0 always (report, don't block)" (`:60`, `:1037`, `:1046`). No cards: "not yet measured" plus "Nothing needs your attention right now." (ran, E1b). Corrupt card log or capture-health file: "health evidence is UNREADABLE" (`:886-911`, `:1010-1014`; ran, E11, E12b). No store: "MACHINERY WORKING, NO STORE" (ran, E9a). Path does not exist: `DEGRADED`, exit 0 (ran, E9c). | No | `/metrics` (user) |
| 7 | `SC/validate.mjs` | Does a simple term-match simulator find the units a test file expects? | `_memories/_validation/tests/test-*.yaml` (`:68`) | `PASS`, `INVESTIGATE`, `FAIL` (`:212`) | **No tests, unreadable folder, or project path missing: "No tests found", exit 0** (`:71`, `:186-189`; ran, E2a, E2c). **A test with no usable expected list scores P=1 R=1 PASS** (`:166-168`; ran, E2b). Any FAIL: exit 1 (`:243-246`). No argument: exit 1. | No | On demand. "Nothing runs this automatically" (`plugins/core/skills/core/protocols/validation.md:100`). |
| 8 | `SC/metrics-detectors.mjs` | Did the agent cite a unit that does not exist, read a stale unit, miss a term the user had to introduce, or let a dated question lapse? | Session transcript; `_memories/` | Status `OK`, `DISABLED`, `UNAVAILABLE`, `NOT_STORED`, `WRITE_FAILED` (`:382-393`, `:464`). Lines "clean" or counts. Anticipation-gap is tagged `[PROVISIONAL — heuristic, uncalibrated]` (`:502`). | No transcript: `UNAVAILABLE (transcript unavailable)`, exit 0 (ran, E6e). Unreadable units are skipped (`:171`, `:363-366`). Exit 0 always (`:510`). | No | `/process-memory` (`plugins/core/skills/process-memory/SKILL.md:279`) |
| 9 | `SC/metrics-rollup.mjs` | What share of today's turns were "asked for something already in context", against the 7-day mean? | Classified rows; calibration state | One line: `rec-fail-tier-0: n/total turns today (x%) vs 7-day avg y% ↑/↓/≈`, tagged `[PROVISIONAL — classifier uncalibrated]` (`:133`, `:146-156`); "no classified turns"; "metrics disabled"; "metrics not stored" | Nothing classified: "no classified turns ... yet" (`:150`). Unregistered project: "metrics not stored: unregistered", exit 0 (ran, E6f). Malformed lines dropped (`:43-49`). Write failure swallowed: "best-effort" (`:191`). Exit 0 always (`:210`). | No | `/process-memory` (`plugins/core/skills/process-memory/SKILL.md:278`) |
| 10 | `SC/classify-turns.mjs` | Which of six recognition states does each turn fall in? | Session transcript; `<project>/CLAUDE.md`, `<project>/MEMORY.md`, `PROJECT.md`, unit names and headings (`:211-216`, `:231-239`) | `tier-0-win`, `tier-1-3-win`, `rec-fail-tier-0`, `rec-fail-tier-1-3-trigger`, `mechanics-failure`, `capture-miss` (`:10-15`). Status `OK`, `DISABLED`, `UNAVAILABLE`, `NOT_STORED`, `WRITE_FAILED` (`:274-329`). Every record `provisional: true` (`:297`). | No transcript: `UNAVAILABLE`, exit 0 (ran, E6d). Missing context files read as empty (`:265`). Exit 1 only on `WRITE_FAILED` (`:383`). | No (regex heuristics) | `/process-memory` only (`plugins/core/skills/process-memory/SKILL.md:277`) |
| 11 | `SC/calibrate-classifier.mjs` | Is the classifier precise enough to drop its "provisional" tag? | Classified rows; a hand-labeled worksheet; sealed predictions | `✔ CALIBRATED`, `○ PROVISIONAL` (`:696`). Status `OK`, `EMPTY`, `ERROR`, `NOT_STORED`. | `--check`: exit 0 if calibrated, 1 if not (`:695`, `:700`). Unreadable or stale state: `available: false` with a reason (`:626-664`). Text mode still prints "pool: 0 turns \| labeled: 0" (ran, E6g). Empty pool on export: message, exit 1 (`:709`). | None in the script. Labeling needs at least two labelers and an adjudicator per row (`:497-500`). | `/process-memory` runs `--check` (`plugins/core/skills/process-memory/SKILL.md:280`). Export and import on demand. |
| 12 | `SC/analyze-retrieval-quality.mjs` | What do the logged retrieval events show: tier mix, dip-backs, escalation? Were answer outcomes recorded? | `_sessions/<date>/retrieval-log.jsonl` and `outcome-log.jsonl` | Five-field receipt: Checked, Safe (`unknown` or `false`, never `true`, `:399-401`), Impact, Action, User action (`:355-409`). Rejected rows by closed code (`:87-95`). | No events: "No retrieval events found ... Safe: unknown", exit 0 (ran, E6h). More than 10% of rows rejected: "effectiveness unknown" (`:353-366`). Project path not a folder: error, exit 2 (`:571-577`; ran, E6i). A log file it cannot read is skipped (`:220`). | No | `/process-memory`; inside `/metrics full` |
| 13 | `SC/analyze-retrieval-skip.mjs` | Was a turn that named a project term answered without touching the store? | Session transcript; high-signal terms from `_memories/` | `CLEAN`, `SKIPS-FOUND`, `UNKNOWN`, `NO-STORE` (`:154-184`). "candidates, not verdicts" (`:215`). | No transcript: `UNKNOWN`, exit 0 (ran, E6b). **Zero terms tracked: `CLEAN`, exit 0 (ran, E6a).** No exit call; always 0 (`:243-248`). | No | `/process-memory` (`plugins/core/skills/process-memory/SKILL.md:243`) |
| 14 | `SC/orphan-detector.mjs` | Is every shipped script reachable from a skill, a protocol, a hook manifest or an import? Is every protocol indexed? | The plugin tree | "N/M scripts reachable"; "ORPHANS"; "REVIEW OVERDUE"; "No un-allowlisted orphans" (`:175-203`) | **Root does not exist: "0/0 scripts reachable. No un-allowlisted orphans", exit 0** (`:58-66`; ran, E3b). Orphans: exit 1 (`:212`). | No | Its own test in CI (`TS/orphan-detector.test.mjs:107-112`). Not run by any skill (`SC/orphan-detector.mjs:45`). |
| 15 | `SC/audit-memory-boundary.mjs` | Which native-memory entries name something the store does not? | Native `MEMORY.md`, default `~/.claude/projects/<slug>/memory/MEMORY.md` (`:49-60`); `_memories/`; `PROJECT.md` | "N native-only candidate(s) / S sampled of T native entries"; each candidate tagged "may be intentionally absent" (`:90`, `:129-131`) | **Native file missing: "0 native-only candidate(s) / 0 sampled of 0 native entries", exit 0** (`:146`; ran, E6c). No exit call; always 0. | No | `/process-memory` (`plugins/core/skills/process-memory/SKILL.md:253`) |
| 16 | `SC/adversarial-run-gate.mjs` | May a multi-agent review's output drive a change, or is it advice only? | The live anti-anchoring capability row | `AUTHORIZED`, `ADVISORY`, `BLOCKED` (`:34`) | Row absent: `BLOCKED`, exit 1 (`:48-60`, `:159`; ran, E15d). Probe error: stderr, exit 2 (`:151-153`). `UNKNOWN` never grants authority (`:92-93`). | No | Before a multi-agent run (`plugins/core/skills/core/protocols/analysis.md:90-100`) |

Four more instruments belong to the approach though the brief did not name them.

| # | Instrument | Question | Verdict words | Missing input | Runs |
|---|---|---|---|---|---|
| 17 | `SC/capability-probe.mjs` | What can this harness do here, with what evidence? | `PASS`, `DEGRADED`, `NOT-YET`, `UNKNOWN`; `PERMITTED`, `BLOCKED` | Unknown harness: one explicit `UNKNOWN` row, never an empty list (`:222-233`; ran, E15c). Startup mode exits 0; pre-action exits 1 when blocked (`:438-442`). | Session start |
| 18 | `SC/check-context-integrity.mjs` | Did the agent load all of MEMORY.md and PROJECT.md? | `CONTEXT-COMPLETE`, `CONTEXT-PARTIAL: ...`, `CONTEXT-COMPLETE (MEMORY.md check skipped ...)` (`:114-116`) | **PROJECT.md path does not exist: bare `CONTEXT-COMPLETE`, exit 0 (ran, E15a).** A file it cannot read counts as 0 lines or 0 bytes (`:120-124`). | Session start (`plugins/core/skills/core/protocols/startup.md:490-497`) |
| 19 | `SC/metrics-package.mjs` | What anonymized numbers can leave the machine? | `available: false` blocks with a reason; `flag[...]` lines | Exit 0 complete, 1 partial (a source was unavailable), 2 failed (`:35-36`, `:1657-1660`). | `/metrics export` |
| 20 | `tests/prose-evals/prose-eval.mjs` | Section 1.7 | `pass`, `fail` | Non-string text is treated as empty (`:84`) | CI only |

**Exit-code summary for the 16 named instruments.** With empty or missing input, eleven exit 0: 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15. Two exit 0 for some missing inputs and non-zero for others: 2 (missing store gives 0; missing gold file gives 1) and 12 (no logs gives 0; path not a folder gives 2). Three exit non-zero: 1, 11, 16. Outside the 16, instrument 19 is the only one that moves its exit code when a source is partly unavailable.

---

## 4. Honesty vocabulary already in the code

### 4.1 Trust labels on numbers

Defined in one object, `SC/metrics-check.mjs:153-156`. Explained to the agent in `plugins/core/skills/metrics/SKILL.md:60`.

| Label | Meaning, in the repo's words |
|---|---|
| `proven-live` | "demonstrated this run on the real product path" |
| `direct` | "real measurement read from disk, not exercised this run" |
| `proxy` | "a stand-in signal, never a correctness proof" |
| `provisional` | "the instrument or its reference isn't independently validated" |
| `not-evaluated` | "no instrument exists for this project yet" |

Two supporting rules:

- The verdict heading covers mechanics only. There is "deliberately NO umbrella top-level verdict" (`SC/metrics-check.mjs:56-58`, `:159-173`).
- A row with no valid denominator gets no bar at all (`SC/metrics-check.mjs:391-398`).

### 4.2 Capability status

Defined in `SC/capability/row-schema.md:21-30`.

| Value | Meaning |
|---|---|
| `PASS` | All evidence agrees |
| `DEGRADED` | Evidence disagrees or is missing; best effort |
| `NOT-YET` | Named but the probe has not completed |
| `UNKNOWN` | The probe failed or returned data it could not read |

Producer rules (`SC/capability/row-schema.md:150-159`): never `UNKNOWN` without an evidence entry naming the failure; never `PASS` without a primary evidence entry; never `DEGRADED` without a conflicting entry. The runner keeps "crashed" apart from "not built": a thrown probe is `UNKNOWN`, a missing one is `NOT-YET` (`SC/capability-probe.mjs:118-131`, `:169-172`; `TS/probe-itself-validation.test.mjs:72-95`).

### 4.3 Other status words

| Words | Where defined | Used for |
|---|---|---|
| `AUTHORIZED`, `ADVISORY`, `BLOCKED` | `SC/adversarial-run-gate.mjs:34` | Whether a review's output may drive a change |
| `OK`, `DISABLED`, `UNAVAILABLE`, `NOT_STORED`, `WRITE_FAILED` | `SC/classify-turns.mjs:274-329`, `SC/metrics-detectors.mjs:382-393`, `:464` | Transcript-based instruments |
| `CLEAN`, `SKIPS-FOUND`, `UNKNOWN`, `NO-STORE` | `SC/analyze-retrieval-skip.mjs:154-184` | Retrieval-skip scan |
| `hit-right`, `hindsight-miss`, `noise`, `storage-gap`, `drift-invalidated` | `SC/hindsight-judge.mjs:18-31` | Hindsight grades |
| `WORKING`, `WORKING-WITH-CAVEATS`, `DEGRADED`, `MACHINERY-WORKING-NO-STORE` | `SC/metrics-check.mjs:849-858` | Mechanics status |
| `CONTEXT-COMPLETE`, `CONTEXT-PARTIAL` | `SC/check-context-integrity.mjs:114-116` | Startup context check |
| `useful`, `partial`, `noisy`, `miss`, `unknown`, with an evidence-authority ladder | `SC/outcome-vocab.mjs:15-27` | Answer outcomes. "'unknown' is a first-class honest state" |
| `valid`, `rejected`, `not-applicable`, with closed rejection codes | `SC/analyze-retrieval-quality.mjs:87-95`, `:124-169` | Log rows |
| `available: false` plus `reason` | `SC/metrics-check.mjs:246-298`, `SC/calibrate-classifier.mjs:650-663`, `SC/metrics-package.mjs:23-27` | Any source that could not be read |
| `release-fresh`, `mismatch`, `indeterminate`, `stale` | `scripts/release/verify-release-identity.mjs:29-33` | Release identity |
| `green`, `refusing`, `no verdict` | `.github/scripts/require-green-candidate.mjs:73-117` | Tag gate |
| `pass`, `FAIL`, `unsupported-but-confined`, `unsupported-observed-outside-access`, `outside_history: 'unknown'` | `tests/acceptance/one-folder-packet.mjs:103-104`, `:111` | Acceptance rows |
| `sourced`, `inferred`, `reconstructed` | `SC/unit-vocab.mjs:85` | Confidence of a stored memory, not of an instrument |

### 4.4 Places that say "unavailable is not zero", or close to it

- "An empty rowset must never be returned as a zero-count success" (`SC/capability-probe.mjs:222-225`).
- "an absence, not a zero score" and "an absence, not a zero" (`SC/render-metrics-artifact.mjs:225`, `:316`, `:318`).
- "Zero valid events is NOT the same claim as zero rows seen" (`SC/analyze-retrieval-quality.mjs:490-491`).
- "missing is not 'no dip-back'" (`SC/analyze-retrieval-quality.mjs:244-246`).
- "'unknown' ... is coverage, never a denominator" (`SC/analyze-retrieval-quality.mjs:341-342`).
- "an explicit '0 rejected' is itself evidence the row was checked, not just assumed clean" (`SC/analyze-retrieval-quality.mjs:504-507`).
- "Absence is not a tier" (`SC/retrieval-harness.mjs:392-395`).
- "No reasoner → the arm is reported unconfigured, never silently equal to the substrate" (`SC/retrieval-harness.mjs:128-129`).
- "The answers above are UNKNOWN, not all-clear" (`SC/metrics-check.mjs:1012`).
- "so no reader mistakes a broken instrument for a quiet one" (`SC/turn-capture.mjs:355-358`).
- "zero captured turns reads the same whether the user opted out or the recorder died", so the card records which (`SC/scorecard.mjs:148-150`).
- "any historical volume masks present silence", so volumes are also counted per window (`SC/scorecard.mjs:105-109`).
- "a traversal that silently collapses makes an unreadable store indistinguishable from an empty one" (`SC/generate-summary-index.mjs:137-141`).
- "an unreadable folder is a recorded state, never an empty one" (`scripts/release/real-home-guard.mjs:27`).
- "indeterminate ... never treated as a pass" (`scripts/release/verify-release-identity.mjs:32`).
- "A run still going is not a verdict" (`.github/scripts/require-green-candidate.mjs:16-17`).
- "`UNKNOWN` ... never wave it off, and never treat it as clean" (`plugins/core/skills/process-memory/SKILL.md:246`).
- Tests with the idea in the title: `TS/calibration-readonly.test.mjs:77` ("a stale persisted instrument cannot become a current measured zero"), `TS/state-cache.test.mjs:243` ("an unreadable cache is not absent — only ENOENT is absence"), `TS/metrics-package.test.mjs:619` ("UNAVAILABLE-with-a-coverage-gap, never available-with-zero-turns"), `TS/incomplete-retrieval.test.mjs:91` ("an inaccessible store root is incomplete, not storeless").

The rule is written down in many places. It is not applied everywhere. Section 6 lists where it is missing.

### 4.5 The doctrine that explains the exit codes

"Observation paths report degraded state and proceed. Mutation paths refuse the action and surface the block reason." (`plugins/core/skills/core/references/architecture-doctrines.md:27-35`). Measurement is treated as observation. That is why most instruments exit 0 and put the verdict in the text.

---

## 5. Self-audit as it exists today

| Check | What it proves | What it cannot see |
|---|---|---|
| **Orphan detector** (script and its test) | Every script and hook file is named in skill prose, a JSON descriptor or a hook manifest, or is imported by a file that is (`SC/orphan-detector.mjs:92-136`). Every protocol is listed in the main skill file (`SC/orphan-detector.mjs:154-161`). An allowlist entry needs a reason and a review date (`TS/orphan-detector.test.mjs:114-119`). | Function-level wiring. It says so itself (`SC/orphan-detector.mjs:195-200`). Example: `runClassifiedRetention` is exported and tested (`SC/classify-turns.mjs:341`, `TS/classify-turns.test.mjs:258-277`) but nothing in the shipped tree calls it (repo-wide search). A name that appears in prose counts as "reached", whether or not anything runs it (`SC/orphan-detector.mjs:120-125`). A missing tree reads as clean (ran, E3b). An overdue review prints a warning and still exits 0 (ran, E3a). |
| **Shipped-surface inventory guard** (a test, a generator, and the committed `docs/shipped-surface-inventory.json`) | The committed inventory equals one built from the tree (`TS/shipped-surface-inventory-guard.test.mjs:55-62`). Count claims in seven public files match (`TS/shipped-surface-inventory-guard.test.mjs:64-104`). Every active skill is named in the install and usage guides (`TS/shipped-surface-inventory-guard.test.mjs:106-113`). Shipped prose cites only paths that ship (`TS/shipped-surface-inventory-guard.test.mjs:148-167`). Root doc links resolve (`TS/shipped-surface-inventory-guard.test.mjs:169-178`). A planted false description turns the check red (`TS/shipped-surface-inventory-guard.test.mjs:231-240`). Inventory shape: `{schema_version, surfaces: [...]}`, 107 entries: 8 skills, 4 hooks, 95 scripts (counted with a one-line `node` script). | Whether a script is ever called: scripts carry "presence only" (`scripts/release/generate-shipped-surface-inventory.mjs:143-147`). A count claim worded differently is not seen. One of the three count tests checks zero claims today (ran, E10). |
| **Doc-contract tests** (one startup contract test and seven `*-doc-guard` files) | Protocol text still names the shipped script path (`TS/startup-doc-contract.test.mjs:19-24`). Two startup commands do not hide their own failure and print a typed failure marker (`TS/startup-doc-contract.test.mjs:26-37`). No Claude-only path is hardcoded for every harness (`TS/startup-doc-contract.test.mjs:39-44`). The `/refocus` skill stays under 10 KiB and 140 lines (`TS/refocus-doc-guard.test.mjs:34-41`). | Whether an agent follows the prose. They are text matches. They cover the commands a past defect touched, not every command. The tripwire command in the same protocol hides its failure and is not covered (gap A2). |
| **Probe-itself validation** (the probe runner and its test) | A probe that throws becomes an `UNKNOWN` row with the error. A probe that will not load becomes `NOT-YET` (`SC/capability-probe.mjs:118-131`; `TS/probe-itself-validation.test.mjs:72-95`). An unprobed harness is one `UNKNOWN` row, not an empty list (`SC/capability-probe.mjs:222-233`). | Whether a probe that returns `PASS` is right. Whether the instruments in Section 3 work; they are not probes. |
| **Link and index checks** | CI checks relative markdown links, but only under `plugins/core/skills/core` (`.github/workflows/ci.yml:196-228`, root set at `:201`). The inventory guard checks backticked paths in all skills and links in four root docs. The orphan detector checks the protocol index. | Markdown links inside the other seven skill folders. Anchors (`#section`) are stripped, not checked (`.github/workflows/ci.yml:217`). |
| **Read-invariant guard** | Seven read paths all hide retired and invalidated units, and still show the active one (`TS/guard-read-invariants.test.mjs:56-86`). | A new read path nobody adds to the list. |
| **Ratchets** | A known duplication cannot grow (`TS/guard-consolidation.test.mjs:38-63`). | It allows the debt that exists: four slug-encoder copies, baseline "frozen 2026-07-02", target 0 (`TS/guard-consolidation.test.mjs:35-46`). |
| **Development-leak scan** | No tracked file carries personal paths, internal names or review labels (`TS/dev-leakage-guard.mjs:5-15`). The scanner states the one file it cannot scan, itself (`TS/dev-leakage-guard.mjs:38-48`). | Meaning. It matches patterns. |
| **Fixture cold-clean** | No test wrote cache files into a checked-in fixture (`TS/fixture-cold-clean.test.mjs:41-47`). | A fixture whose content was edited. |
| **CI glob-zero guard** | The syntax and import checks did not silently run on zero files (`.github/workflows/ci.yml:27`, `:188`). | Only those two steps have it. |
| **Context-integrity check** | A truncated MEMORY.md or a partly read PROJECT.md is named before the first answer. A skipped check is named as skipped (`SC/check-context-integrity.mjs:110-116`). | A file it cannot read counts as zero lines and yields `CONTEXT-COMPLETE` (`SC/check-context-integrity.mjs:120-124`; ran, E15a). |

**What is missing as a class.** Nothing checks the instruments in Section 3 as a set. There is no test that feeds each instrument an empty, missing and unreadable input and asserts it does not print a clean line or exit 0. `docs/regression-guards.md:13` lists that pattern as "add as found".

---

## 6. Gaps and weak spots

Each item says what happens, where, and how I know.

### A. An instrument reads nothing and still exits 0 or prints a clean line

**A1. Capture that never worked is invisible.** A project with 30 logged retrievals and zero evidence rows:

- The session-start check prints nothing, exit 0 (E1a).
- `/metrics` says "not yet measured — evidence is being captured" and "Nothing needs your attention right now." (E1b). Nothing was being captured.
- The maintenance pass says nothing about it (E1f).

Why: every silence wire needs a pinned card (`SC/metrics-tripwires.mjs:66-67`). A card is pinned only when a grade or self-test row exists (`SC/scorecard.mjs:187-192`). With no evidence there are no grades. The "evidence is being captured" text prints whenever capture is not switched off and nothing has been graded. It does not check that any evidence row exists (`SC/metrics-check.mjs:949-952`). The maintenance pass adds a note only when something was judged or an error was returned (`SC/maintenance-run.mjs:166-173`). A test fixes this as intended behavior: "no scorecards at all → healthy silence" (`TS/metrics-tripwires.test.mjs:274-281`).

**A2. The session-start check hides its own failure.** The protocol runs it as `... metrics-tripwires.mjs <project> 2>/dev/null || true`, and says "No output → say nothing" (`plugins/core/skills/core/protocols/startup.md:483-488`). A crash, a missing script and a healthy project look the same. The doc-contract test bans this exact pattern for two other commands (`TS/startup-doc-contract.test.mjs:26-37`). It does not cover this one.

**A3. Two readers of the same evidence disagree.** With a corrupt capture-health file, the tripwire function returns `{"healthy":true,"tripped":[]}` while the `/metrics` view prints "health evidence is UNREADABLE" (E11). Same with a corrupt card log (E12a, E12b). The tripwire treats unreadable history as "healthy silence" by design (`SC/metrics-tripwires.mjs:60-61`) and never looks at the `unreadable` field the health reader sets (`SC/metrics-tripwires.mjs:137-148`, `SC/turn-capture.mjs:355-374`). The automatic reader is the silent one.

**A4. The harness scores a store that is not there.** A path that does not exist gives "store: 0 active units", a full table of 0.00, and exit 0 (E8b). The policy sweep prints `forbidden@3 0` when no question had a forbidden list (`SC/retrieval-harness.mjs:448`; E8f). The harness fails loud on a bad answer key but has no check that the store exists (`SC/retrieval-harness.mjs:100-113`).

**A5. `validate.mjs` passes on nothing.** No tests: exit 0 (E2a). A project path that does not exist: exit 0 (E2c). A test whose expected list uses the wrong key names a unit that does not exist and scores `[PASS] P=1 R=1` (E2b; `SC/validate.mjs:166-168`).

**A6. The orphan detector passes on an empty tree.** "0/0 scripts reachable. No un-allowlisted orphans", exit 0 (E3b; `SC/orphan-detector.mjs:58-66`).

**A7. The context check reports complete when it read nothing.** A PROJECT.md path that does not exist gives a bare `CONTEXT-COMPLETE` (E15a). The protocol says a bare marker "needs no narration" (`plugins/core/skills/core/protocols/startup.md:490`).

**A8. The retrieval-skip scan says CLEAN with zero terms tracked.** In E6a the store says the widgets are blue. The agent answered "They are red" without touching the store. Output: `retrieval-skip: CLEAN`. `termsTracked: 0` appears only in `--json` (`SC/analyze-retrieval-skip.mjs:184`, `:196-200`, `:203-216`).

**A9. The memory-boundary audit does not say its input was missing.** "0 native-only candidate(s) / 0 sampled of 0 native entries" (E6c; `SC/audit-memory-boundary.mjs:146`). The zero denominator is the only hint.

**A10. The detectors print "clean" over an unreadable store.** A unit it cannot read is skipped (`SC/metrics-detectors.mjs:171`). A folder it cannot list yields nothing (`:363-366`). A bad date counts as zero days old (`:124-131`). The CLI then prints "stale-context: clean" and "absence-with-deadline: clean" (`:491`, `:503`). Code reading only; not run.

**A11. Judge and scorecard read unreadable files as empty.** "unreadable file contributes nothing" (`SC/hindsight-judge.mjs:79`, `SC/scorecard.mjs:54`). Both then exit 0 (E1c, E1d, E12c).

**A12. Self-test rounds have four soft spots.**

- An earlier round that fails to load is skipped, and the report says "this is the first round" (E5b; `SC/self-test-round.mjs:597-600`, `:836-837`).
- The frozen answer key is not checked against its registered hash at run time. I replaced a frozen set with one easy question. The run printed the registered hash and "headline 100%" (E5c). The real file hash is in the results JSON only (`SC/self-test-round.mjs:568-583`, `:616-623`, `:822`).
- An abstention question with no trap list is counted in the question total and scored nowhere (E5 round 2: `n_queries: 3`, `forbiddenRate: null`). Registration did not warn.
- The result of the log write is ignored (`SC/self-test-round.mjs:674`, `:688`), though the writer returns a reason on failure (`SC/log-event.mjs:425-451`).

**A13. The full view prints HEALTHY next to the evidence of a dead recorder.** "30 typed events / 1 days" sits one row above "0 row(s) / 0 day(s), 0 of 0 writes failed", under `MECHANICS: HEALTHY` (E9b). The status ignores capture coverage (`SC/metrics-check.mjs:851-858`).

**A14. One self-audit test checks zero claims.** The deprecation-shim count test found no claim in any of the seven files it reads, so no assertion runs (E10; `TS/shipped-surface-inventory-guard.test.mjs:73-80`).

**A15. One evaluation test cannot fail on the behavior in its name.** "recent self-test trap-leak shifts temporal -> abstention" asserts the shift only `if (rows[0].trap_leak_rate > 0)` (`TS/self-test-round.test.mjs:440-449`). In its own scenario the measured rate is 0 (E14). No other test covers the shift (repo-wide search for `quota.abstention`).

**A16. An unavailable recall renders as 0%.** `gold.context3_r3 ?? 0` (`SC/metrics-check.mjs:461`, `:602`). And the harness text table never prints the delivered-context arm's only number: the arm reports K=3 only (`SC/retrieval-harness.mjs:122`), the table prints K=5, 10, 30, 100 (`:303-306`), so that row is all dashes (E8c, E8d).

**A17. A text line shows zeros for an unavailable instrument.** `calibrate-classifier --check` printed "pool: 0 turns | labeled: 0 | precision: n/a" above "No trusted calibration data is available." (E6g; `SC/calibrate-classifier.mjs:696-698`).

### B. Measurement depends on a hardcoded path

**B1. The headline classifier looks for memory in the wrong place.** It builds "what was in context" from `<project>/CLAUDE.md` and `<project>/MEMORY.md` (`SC/classify-turns.mjs:211`). Three other scripts locate the harness's injected memory at `~/.claude/projects/<slug>/memory/MEMORY.md` (`SC/audit-memory-boundary.mjs:59`, `SC/check-context-integrity.mjs:66`, `SC/capability/auto-memory-injection-probe.mjs:56`). A missing file reads as empty with no warning (`SC/classify-turns.mjs:265`). So the failure this instrument exists to count, "asked for something already in context", cannot fire for auto-memory content. Code reading only; I had no live project to confirm the size of the effect.

**B2. The boundary audit defaults to the Claude path** (`SC/audit-memory-boundary.mjs:49-60`, `:145`). On another harness it reads nothing and prints the line in A9.

**B3. Transcript-based instruments depend on harness transcript paths**: `~/.claude/projects/<slug>/<session>.jsonl` and `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`SC/read-transcript.mjs:15-17`, `:76`, `:95`). When absent they say `UNAVAILABLE` or `UNKNOWN`. That part is honest.

**B4. Fixed input locations inside the project.** Gold set at `_tests/retrieval-gold-set.json` (`SC/retrieval-harness.mjs:487`). Validation tests at `_memories/_validation/tests` (`SC/validate.mjs:68`). Rounds at `_tests/self-test/round-N` (`SC/self-test-round.mjs:111-116`). Retrieval logs at `_sessions/<date>/retrieval-log.jsonl` (`SC/metrics-check.mjs:804-813`). Unit census reads the top level of `_memories/` only (`SC/metrics-check.mjs:784-785`), though nested units are supported (`TS/retrieval-premise.test.mjs:40-47`).

**B5. Version identity depends on a relative path to the manifest** (`SC/metrics-check.mjs:101`, `SC/retrieval-harness.mjs:165`). If it does not resolve, the version is null and the run continues.

### C. Thresholds without a stated basis

| Threshold | Value | Where | Basis given |
|---|---|---|---|
| Gap floor | 0.5 | `SC/hindsight-judge.mjs:61` | None. "so the value can be derived from real baseline data later" (`:33-38`) |
| Storing verdict | gaps ≤ 10% is MOSTLY | `SC/metrics-check.mjs:958` | None |
| Loading verdict | ≥ 95% YES, ≥ 75% MOSTLY | `SC/metrics-check.mjs:973` | None |
| Minimum graded turns | 20 | `SC/metrics-check.mjs:943` | A reason, no derivation (`:940-942`) |
| Tripwires | drop 0.05, floor 0.5, 3 cards, 2 cards, 10% at 20 attempts, 3 in a row, 50% at 20, 14 days | `SC/metrics-tripwires.mjs:37-48` | "spec Component 4 + the review-set Gate-A floors" (`:14`). No spec file is tracked (`git ls-files` has no spec, design or plan file). |
| Calibration | precision 0.7, 100 labels, 10 per state, interval lower bound 0.5 | `SC/calibrate-classifier.mjs:45-49` | "spec §17.12" (`:5`). Not in the repo. |
| Quota shift | escalation rate > 0.3; last 5 runs | `SC/self-test-round.mjs:200-201` | None |
| Round staleness | 20% growth, 10 session-days, 7-day cap | `SC/self-test-round.mjs:697-701` | The cap is a cost guard (`:704-705`). The others: none. |
| Validation verdicts | 0.8 and 0.5 | `SC/validate.mjs:212`, `plugins/core/skills/core/protocols/validation.md:84-86` | None |
| Stale unit | 30 days | `SC/metrics-detectors.mjs:102` | None |
| Rare-term cutoff | 5% of units | `SC/metrics-detectors.mjs:225` | A reason, no derivation |
| Corrupt-row cutoff | 10% | `SC/analyze-retrieval-quality.mjs:353` | A reason, no derivation |
| Trend arrow | ±0.02 | `SC/metrics-rollup.mjs:154` | None |
| Self-test minimum store | "~30 active units" | `plugins/core/skills/metrics/SKILL.md:93` | None, and prose only (D2) |
| Prose obligations | "executed ~40% of the time" | `docs/change-review-prompt.md:17` | No source in the repo |

Two thresholds do state a measured basis. The precision floor is "ratcheted to just under the measured value (0.850)" (`TS/retrieve-precision.test.mjs:58-60`). The capture budget quotes measured medians (`TS/metrics-perf.test.mjs:41-48`).

### D. Small-n problems

**D1. One question trips the drop alarm.** A default round has 12 questions (`SC/self-test-round.mjs:93-100`). The abstention question has no expected id, so it is left out of recall (`SC/retrieval-harness.mjs:60-65`). The headline is a mean over 11. One question is 9.1 points. The drop wire fires above 5 points (`SC/metrics-tripwires.mjs:38`, `:74`).

**D2. Nothing enforces a minimum round.** The quota is a ceiling. Under quota only warns (`SC/self-test-round.mjs:459-470`). I registered a round of two literal questions on a six-unit store. Headline: 100% (E5 round 1). The "~30 active units" rail is prose (`plugins/core/skills/metrics/SKILL.md:93`); the script checks only that `_memories/` exists (`SC/self-test-round.mjs:256-258`). The script's own tests run on six units (`TS/self-test-round.test.mjs:85`).

**D3. The CI retrieval-quality gate is ten queries on six active units.** The "N sweep (2 vs 3 vs 5)" printed the same numbers for every N in my run: precision 0.850, recall 1.000 (Appendix B, T1). On that fixture the sweep cannot tell the settings apart.

**D4. The tier-safety gold set is one query** (`tests/fixtures/tier-safety-store/_tests-goldset.json:1`).

**D5. Prose evals are two scenarios and five canned answers** (Section 1.7).

**D6. Grades are cumulative, volumes are windowed.** The card counts every judgment row ever written (`SC/scorecard.mjs:87-97`). Volumes got a per-window count because "any historical volume masks present silence" (`:105-109`). Grades did not. A long clean history can hide a bad recent week. The 20-turn minimum does not help once the total is large.

**D7. Calibration needs a lot.** 100 unique labels, at least 10 gold and 10 predicted per state across six states, two labelers and an adjudicator per row, in each of two harnesses (`SC/calibrate-classifier.mjs:45-50`, `:497-513`, `:559`). The code calls staying provisional "the EXPECTED steady state" at single-user scale (`:52-58`).

### E. Labeled provisional, degraded or overdue for a long time

- **Recognition classifier.** Provisional since 3.4.0, dated 2026-06-02 (`CHANGELOG.md:577-582`). Still provisional by default at 3.20.1, dated 2026-10-17 (`CHANGELOG.md:10`; `SC/calibrate-classifier.mjs:76-98`). The startup protocol still tells the agent it "isn't calibrated yet" (`plugins/core/skills/core/protocols/startup.md:523`).
- **Self-test and gold snapshot.** Always `provisional`, by design (`SC/metrics-check.mjs:448-455`).
- **Agent isolation.** `DEGRADED`, closure target `'unscheduled'` (`SC/capability/anti-anchoring-mechanism-probe.mjs:21`, `:36`). "This is the normal case on Claude Code today" (`plugins/core/skills/core/protocols/analysis.md:99`).
- **Reasoning-tier retrieval.** "shipped and tested, no calibrated measurement yet of its effect on retrieval quality", 3.12.0, 2026-07-18 (`CHANGELOG.md:410-413`).
- **Anticipation-gap detector.** `provisional: true`, "not calibrated; never surface as graded" (`SC/metrics-detectors.mjs:436`).
- **Gap floor.** Waiting for "real baseline data later" (`SC/hindsight-judge.mjs:33-38`).
- **Orphan allowlist.** Review due 2026-10-28 (`SC/orphan-detector.mjs:44-48`). Today it prints "REVIEW OVERDUE" and exits 0 (E3a). The test checks the date's format, not that it is in the future (`TS/orphan-detector.test.mjs:114-119`).
- **Slug-encoder duplication.** Baseline 4, frozen 2026-07-02, target 0 (`TS/guard-consolidation.test.mjs:35-46`).
- **Pattern 1 and pattern 3 guards.** "manual for now" and "add as found" (`docs/regression-guards.md:11`, `:13`).

### F. The measure does not mean what its name says

**F1. The calibration blind leaks.** The worksheet omits the prediction but includes `context_evidence: t.evidence` (`SC/calibrate-classifier.mjs:374`). The classifier's evidence object has a different shape for each state (`SC/classify-turns.mjs:129-153`). I built one turn per state with the shipped classifier and exported a worksheet. Six rows, six distinct evidence shapes, each matching its sealed prediction (E4). A labeler can read the answer off the row. The test for blindness checks only that `heuristic_state` is absent (`TS/calibrate-classifier.test.mjs:284`).

**F2. The hindsight grade is the retriever agreeing with itself.**

- The judge's header says the live hook "saw a byte-capped view (≤8 keyword tokens)" and the judge sees the full prompt (`SC/hindsight-judge.mjs:5-16`).
- The hook passes the full prompt to the retriever (`plugins/core/skills/core/hooks/retrieve-context-hook.mjs:139`, `:171`). The 8-token cut is applied only to the topics written in the log row (`:276`).
- The judge calls the same function on the same text (`SC/hindsight-judge.mjs:139`).
- I delivered exactly what the pipeline delivers for ten prompts, then judged them. Eight `hit-right`, two `noise` (E16).
- One `hit-right` was "zenith el primero on sale", where the pipeline delivered the wrong unit. The repo's own ladder says the right unit is `values-heritage` and that lexical search cannot reach it (`TS/obligation3-ladder.test.mjs:20`, `:45`).
- One `noise` was the edge neighbor that another test requires to be delivered (`TS/retrieval-premise.test.mjs:82-97`).

The view labels the line "(mechanical grade)" and the docs explain the limit (`plugins/core/skills/metrics/SKILL.md:41`, `USAGE.md:68`). The line still reads "right memories 89% of turns" (`SC/metrics-check.mjs:974`).

**F3. "Storing the right memories" means "something shares words".** `storage-gap` is given only when nothing in the store scores at or above the floor for the prompt (`SC/hindsight-judge.mjs:19-21`, `:88-90`). "YES — no gaps found" (`SC/metrics-check.mjs:958-959`) therefore means every graded prompt had at least one weak word match.

**F4. The overfitting note has the sign backwards.** `delta = headline − priorMean` (`SC/self-test-round.mjs:604`). When the new round is harder, the delta is negative. I ran it: "↓ -100 pts vs the older rounds' mean (100%)", and on the next line "(a big positive delta — new questions much harder than old — can mean the store was tuned to the old set)" (E5 round 2; `SC/self-test-round.mjs:834-835`). The skill repeats it: "a large positive delta = the store may be tuned to its old test" (`plugins/core/skills/metrics/SKILL.md:90`).

**F5. Two different numbers carry the name "blind test".** The default view and the tripwires use Recall at 10 on the pre-expansion ranker (`SC/self-test-round.mjs:535-536`; `SC/scorecard.mjs:136-139`). The full view's bar uses Recall at 3 on the delivered context (`SC/metrics-check.mjs:461`, `:489-491`). The product delivers 3 within a 2,048-byte cap (`plugins/core/skills/core/hooks/retrieve-context-hook.mjs:55-56`).

**F6. The classifier scores a win by default.** Any reply with no clarifying phrase is `tier-0-win` or `tier-1-3-win` (`SC/classify-turns.mjs:129-133`). An agent that answers wrongly from its head scores a win.

**F7. One instrument reads a stream that has no writer.** The answer-outcome writer "was deleted from the shipped tree" (`SC/outcome-vocab.mjs:7-10`; `plugins/core/skills/core/references/retrieval.md:159-163`). The analyzer still reports "answer outcome unknown" and advises "Record an evidence-qualified answer outcome after each retrieval-backed answer" (`SC/analyze-retrieval-quality.mjs:390-397`).

**F8. `validate.mjs` is not the product.** Its header says "NOT-PRODUCT-PATH ... must never be cited as product baselines" (`SC/validate.mjs:11-17`).

### G. Docs and code disagree inside the measurement layer

- **A documented knob that does not exist.** The docstring says a workspace can set `calibration_min_labeled`, floor 30 (`SC/calibrate-classifier.mjs:52-59`). The function ignores its argument and returns 100 (`:60-63`). Tests confirm the setting is ignored (`TS/calibrate-classifier.test.mjs:425-439`).
- **Three accounts of when the recognition signal refreshes.** "only from user-invoked /finalize and /process-memory" (`SC/classify-turns.mjs:23-27`). "the last time `/process-memory` or `/metrics` ran" (`plugins/core/skills/core/protocols/startup.md:523`). In the skills, only `/process-memory` runs it (`plugins/core/skills/process-memory/SKILL.md:277-280`; no match in the finalize or metrics skills).
- **The signal's age is computed and never shown.** `age_hours` is stored (`SC/metrics-check.mjs:824`). The row and the narrative use the text only and say "this session" (`:512`, `:609-611`). Outside tests, the only other mention is a schema line (`SC/render-metrics-artifact.mjs:440`).
- **The validation protocol describes more than the runner does.** It promises a final "Did retrieval feel right in real use?" field and four test classes (`plugins/core/skills/core/protocols/validation.md:30-35`, `:116`). The report holds a results line, a table and a detail list (`SC/validate.mjs:225-237`).
- **The judge's header and the hook.** See F2.
- **A function the tree never calls.** See Section 5, orphan detector.

---

## 7. Cost

### 7.1 Test count

- 176 test files and 4 helper modules in `tests/scripts/` (`ls tests/scripts`: 180 entries).
- About 2,200 static test call sites: 2,190 at line start, 2,216 counting one-line loops (`grep` counts, Appendix B, C1). Some sit in loops, so the run-time count is higher. I did not run the suite, so I do not have the exact number.
- 158 conditional skip markers, mostly for Windows, root, or missing symlink rights (same count run).
- The changelog last states a suite size at 3.10.0: "The test suite grew 739 → 771" (`CHANGELOG.md:478`).

### 7.2 Time

- Three files, 15 tests, 0.18 seconds (Appendix B, T1). The runner works.
- Whole-suite time: unknown. The repo states none (searched changelog, docs, workflows). No workflow sets a timeout.
- CI runs the suite twice, on Linux and Windows (`.github/workflows/ci.yml:277-280`), plus the validate job and the smoke job.
- Run-time budgets enforced by test: evidence capture under 25 ms median on an idle host, never past 110 ms; a 50-turn judge batch over 200 units under 10 seconds (`TS/metrics-perf.test.mjs:1-10`, `:44-55`, `:127-143`).

### 7.3 Lines

| What | Files | Lines |
|---|---|---|
| Shipped scripts (`SC/**/*.mjs`) | 95 | 33,492 |
| Shipped hooks | 5 | 821 |
| Shipped markdown | 40 | 6,426 |
| Everything under `plugins/core` | 148 | 41,001 |
| Tests, all files | 229 | 42,064 |
| Test code only (`.mjs` and `.sh`) | — | 41,626 |
| Release and CI scripts | 6 | 807 |

Counts from `find ... | xargs cat | wc -l` (Appendix B, C2).

- Test code to shipped code: 41,626 to 34,313, about 1.2 to 1.
- The 16 named instruments are 6,580 lines, 19% of shipped code.
- Counting every measurement and observability script (37 files by my grouping, Appendix B, C3) gives 13,774 lines, 40% of shipped code.

### 7.4 Model calls

- CI: none.
- Blind self-test: one authoring subagent per round. The automatic trigger is capped at once a week (`SC/self-test-round.mjs:697-701`).
- Calibration: at least two labelers and one adjudicator for each of 100 or more rows, per harness (`SC/calibrate-classifier.mjs:497-500`, `:511-513`).
- Harness `escalated` arm: one external reasoner call per triggered question, cached by prompt hash (`SC/retrieval-harness.mjs:239-248`).
- Change review: one fresh agent per change, manual (`docs/change-review-prompt.md:33`).

### 7.5 Stored data

Each turn stores the prompt, up to 64 KiB, and the delivered context, up to 16 KiB, locally (`SC/turn-capture.mjs:66-67`). Rows are kept until the user purges them (`SC/maintenance-run.mjs:137-139`).

---

## 8. What a rewrite must keep, what it can drop

My judgement. One line each, with the evidence.

### Keep

1. **Three answers, not two: measured, measured zero, unavailable.** Best example: `TS/calibration-readonly.test.mjs:54-89` injects nine faults and asserts `available: false`, while a truly absent file stays a usable zero.
2. **Exit codes where "no verdict" is neither pass nor fail.** `.github/scripts/require-green-candidate.mjs:19-22`; `scripts/release/verify-release-identity.mjs:29-33`; `SC/metrics-package.mjs:35-36`.
3. **Controls before trust.** A negative and a positive control run before the suite and stop it (`scripts/release/run-suite-isolated.mjs:56-81`). A quiet control fails the packet (`tests/acceptance/one-folder-packet.mjs:186-210`).
4. **A check with no expectation fails.** `tests/acceptance/one-folder-packet.mjs:100`; "script glob matched zero files" (`.github/workflows/ci.yml:27`).
5. **Measure a frozen snapshot, and prove it.** `SC/retrieval-harness.mjs:106-112`; falsifiers at `TS/retrieval-harness.test.mjs:147-208`.
6. **Call the product functions, never a copy.** `SC/retrieval-harness.mjs:4-8`; `TS/retrieval-premise.test.mjs:68-80`.
7. **Refuse a weak answer key.** `SC/retrieval-harness.mjs:329-375`.
8. **Adversarial fixtures that check themselves.** Retired poison unit, stuffed vocabulary, wrong-but-active, edge neighbor with no shared word (`TS/retrieval-premise.test.mjs:88-91`, `:172-192`; `TS/policy-safety.test.mjs:62-100`).
9. **Pin a known weakness as a test.** "CHARACTERIZED" and "PINNED" tests (`TS/policy-safety.test.mjs:62-75`, `:93-100`).
10. **Pre-registered question rounds with mechanical checks.** Zero word overlap, false-premise checks, quota, store identity (`SC/self-test-round.mjs:372-482`). Add a hash check at run time (gap A12).
11. **Pinned conclusions stamped with producer, judge version and thresholds.** `SC/scorecard.mjs:127-151`; `SC/maintenance-run.mjs:186-188`.
12. **Never mix instruments.** Rows from another classifier version go to a counted "coverage gap" (`TS/metrics-rollup.test.mjs:288-317`). Replays count once (`:218-246`).
13. **A trust label on every number, and no umbrella verdict.** `SC/metrics-check.mjs:153-176`.
14. **State the sample size before a verdict.** `SC/metrics-check.mjs:940-945`; `TS/metrics-answers.test.mjs:170-183`.
15. **Tell opt-out from dead.** `SC/scorecard.mjs:148-150`; `TS/metrics-capture-disabled.test.mjs:59-85`.
16. **Count per window, not only in total.** `SC/scorecard.mjs:105-125`. Extend it to grades (gap D6).
17. **Planted canaries for what must never leave.** `TS/turn-capture-exporter-isolation.test.mjs:61`; `TS/metrics-package.test.mjs:152`.
18. **The file-access gate that records and refuses.** `tests/scripts/fs-confine.mjs:1-14`.
19. **Build from committed files; say what the check does not prove.** `tests/smoke/source-package-smoke.sh:2-13`.
20. **An empty answer is not a pass.** `tests/smoke/source-package-smoke.sh:116-125`.
21. **Docs checked against the tree, with a planted falsifier.** `TS/shipped-surface-inventory-guard.test.mjs:55-62`, `:231-240`.
22. **One fixture against every reader.** `TS/guard-read-invariants.test.mjs:56-86`.
23. **Ratchets for debt you cannot pay today.** `TS/guard-consolidation.test.mjs:35-63`; `docs/regression-guards.md:27-29`.
24. **Show the defect at the old commit and its absence at the tip.** `TS/close-hook-regression-parent-sha.test.mjs:1-21`.
25. **Write failure is not success.** `SC/classify-turns.mjs:305-329`; `TS/metrics-write-contract.test.mjs:175`.
26. **A deterministic floor for prose.** Planted obligations, injection markers, forbidden claims (`tests/prose-evals/prose-eval.mjs:11-20`). Run it on real output, not only canned answers.
27. **The evidence row per turn.** Prompt, delivered context, store signature (`plugins/core/skills/core/protocols/data-storage.md:395`). It is the raw material any later blind comparison needs.
28. **The five defect patterns as a review checklist.** `docs/change-review-prompt.md:15-27`.
29. **Timing budgets that scale with host load.** `TS/metrics-perf.test.mjs:50-55`.

### Drop or replace

1. **The hindsight judge as the answer to "is it loading the right memories".** It grades self-agreement (gap F2, E16).
2. **The recognition classifier, its rollup and its calibration harness.** Provisional for five months, not calibratable at one-user scale by its own account, default-win logic, wrong context path (gaps E, D7, F6, B1). About 1,580 lines across four scripts (`classify-turns` 384, `calibrate-classifier` 733, `metrics-rollup` 211, `metrics-dedupe` 254).
3. **`validate.mjs`.** Not the product path; passes on nothing (gaps F8, A5).
4. **The answer-outcome reader.** Its writer is gone (gap F7).
5. **The anticipation-gap detector.** Provisional heuristic that may never be surfaced as graded (`SC/metrics-detectors.mjs:436`).
6. **"Silence means healthy" at session start.** Replace with a line that proves the check ran (gaps A1, A2, A3).
7. **The old-vs-new delta in its current form.** Wrong-sign note, no threshold, not pinned, skipped on the automatic path (gap F4, Section 2.5).
8. **Recall at 10 on the pre-expansion ranker as the headline.** The product delivers 3 (gap F5).
9. **The two-harness calibration requirement.** `SC/calibrate-classifier.mjs:559`. It doubles a cost nobody has paid once.
10. **Thresholds that cite a spec the repo does not hold.** Re-derive or state "chosen, not measured" (Section 6 C).
11. **Tier-policy sweep machinery, unless a policy other than the identity ships.** The default is `'P0'`, "identity" (`SC/retrieve-context.mjs:233`, `:249`). The sweep and the P1 to P3 branches weigh options that are not on. Keep the fixtures' retired-unit and invalidated-unit checks (Keep item 8).
12. **The assertions that forbid a benefit row.** `TS/metrics-check.test.mjs:343-348`, `:410-413`. They encode a decision the rewrite reverses.

---

## Appendix A — every file in `tests/scripts/`, by subject

180 entries: 176 test files and 4 helper modules. Descriptions come from each file's header and test titles.

### A1. Evaluation and measurement instruments (34)

- `aggregate-receipt.test.mjs` — shareable harness receipt: whitelist build, refusal scan for ids, text and paths.
- `analyze-retrieval-quality.test.mjs` — retrieval-log analyzer: row validation with closed codes, unknown-aware rates, five-field receipt.
- `analyze-retrieval-skip.test.mjs` — scan for term-bearing turns answered without touching the store; UNKNOWN when it cannot see.
- `audit-memory-boundary.test.mjs` — native-memory versus store candidates; anti-resurrection label.
- `calibrate-classifier.test.mjs` — precision and coverage math, sealed-prediction worksheet, two-harness gate.
- `calibration-output-preservation.test.mjs` — a worksheet with labels is never overwritten unless asked.
- `calibration-readonly.test.mjs` — readiness read changes nothing; absent, unreadable and stale are different answers.
- `classify-turns.test.mjs` — six recognition states, term extraction, in-context check, session binding.
- `hindsight-judge.test.mjs` — the five verdicts, drift, idempotence, malformed rows.
- `metrics-answers.test.mjs` — default `/metrics` view: three answers, thin-evidence wording, UNREADABLE escalation.
- `metrics-capture-disabled.test.mjs` — opt-out and dead recorder are told apart.
- `metrics-check.test.mjs` — full `/metrics` report: bars, trust labels, evidence classes, JSON contract.
- `metrics-dedupe.test.mjs` — replay dedupe and instrument-cohort gate.
- `metrics-detectors.test.mjs` — citation, stale-context, anticipation-gap and overdue-question detectors.
- `metrics-perf.test.mjs` — timing budgets for capture and a judge batch.
- `metrics-rollup.test.mjs` — daily recognition rollup, PROVISIONAL gating, cohort gap.
- `metrics-tripwires.test.mjs` — each degradation wire; round-staleness policy.
- `metrics-write-contract.test.mjs` — opt-out stops derived-metrics writes; a failed write is not OK.
- `obligation3-ladder.test.mjs` — four-rung ladder; lexical baseline hits rung one, misses the value rung.
- `policy-safety.test.mjs` — tier policies against wrong, stuffed, retired and invalidated distractors.
- `prose-eval.test.mjs` — prose rubric against five canned answers.
- `read-transcript.test.mjs` — transcript adapter for both harnesses; an unidentifiable transcript is UNKNOWN, not the answer.
- `record-retrieval-event.test.mjs` — retrieval event writer rejects malformed rows.
- `retrieval-harness.test.mjs` — Recall math, gold validation, frozen-snapshot falsifiers, escalated arm.
- `retrieval-premise.test.mjs` — nested units, harness equals product ranking, edge expansion, stale cache, tier safety.
- `retrieval-producer-schema.test.mjs` — startup protocol states the exact retrieval event schema.
- `retrieve-precision.test.mjs` — precision at 3 floor of 0.80 on ten queries; N sweep.
- `scorecard.test.mjs` — pinned card: aggregation, nulls on missing input, append-only, window.
- `self-test-round.test.mjs` — round lifecycle, verifier rules, delta plumbing, quota reshaping.
- `turn-capture.test.mjs` — evidence stream: gates, byte caps, health counter, retention, purge.
- `turn-capture-chaos.test.mjs` — concurrent appends and a purge race keep rows whole.
- `turn-capture-exporter-isolation.test.mjs` — planted canary: the exporter never emits evidence content.
- `turn-capture-hook.test.mjs` — the hook writes an evidence row joined to the numbers row.
- `validate.test.mjs` — `validate.mjs` CLI: forbidden hits, negation, row consistency.

### A2. Retrieval product path (17)

- `bitemporal.test.mjs` — validity dates and supersession stamps.
- `capture-store.test.mjs` — one atomic store capture under live concurrent writers.
- `enrichment-sidecar.test.mjs` — enrichment sidecar validity and its ranking arm.
- `final-context-pack.test.mjs` — the delivered pack: byte accounting, cap, equality with hook output.
- `generate-memory-index.test.mjs` — MEMORY.md top-units block; argument validation.
- `generate-summary-index.test.mjs` — summary index content and truncation.
- `generate-unit-index.test.mjs` — decisions and risks index files; atomic write.
- `graph-walk.test.mjs` — edge walk hides invalidated units by default.
- `incomplete-retrieval.test.mjs` — a read failure is "incomplete", never a clean empty result.
- `is-retrievable.test.mjs` — a retired unit surfaces through no reader.
- `priority.test.mjs` — ranking and validity predicates; unreadable units are listed, not dropped.
- `reasoning-shortlist.test.mjs` — thin-signal trigger and escalation pack.
- `retrieve-context.test.mjs` — tokenizer, lexical ranking, retired suppression, CLI flags.
- `retrieve-context-staleness.test.mjs` — the index regenerates when units change.
- `retrieve-hook.test.mjs` — per-turn hook: opt-out, byte caps, escalation, registration gate.
- `retrieve-stray-write.test.mjs` — retrieval writes nothing where there is no store.
- `select-relevant-units.test.mjs` — candidate shards for the reasoning tier.

### A3. Capability probes and gates (14)

- `adversarial-run-gate.test.mjs` — AUTHORIZED, ADVISORY, BLOCKED decisions.
- `analyze-capability-drift.test.mjs` — degrading versus healing drift between sessions.
- `anti-anchoring-mechanism-probe.test.mjs` — honest DEGRADED row for trust-based isolation.
- `auto-memory-injection-probe.test.mjs` — MEMORY.md path mapping and state.
- `capability-history.test.mjs` — append-only history and row hashing.
- `capability-probe.test.mjs` — runner: descriptor load, harness detection, UNKNOWN row for an unprobed harness.
- `capability-wireins.test.mjs` — the snapshot is appended and drift analysis consumes it.
- `instruction-surface-resolution-probe.test.mjs` — instruction-file chain resolution.
- `memory-accessed.test.mjs` — was the store reached this session; UNKNOWN when unobservable.
- `memory-visible-in-agent-context-probe.test.mjs` — is auto-memory visible in the transcript.
- `probe-itself-validation.test.mjs` — a probe crash is UNKNOWN, a missing probe is NOT-YET; row backfill.
- `record-capability-snapshot.test.mjs` — session id resolution; an incomplete snapshot is reported.
- `restrictive-mode.test.mjs` — one-folder mode observes nothing outside.
- `target-surface-collab-files-probe.test.mjs` — write-proof probe; no baked-in personal repo.

### A4. Self-audit and doc-contract guards (19)

- `adapter-doc-guard.test.mjs` — harness adapter prose keeps required mappings.
- `check-context-integrity.test.mjs` — truncated MEMORY.md or partial PROJECT.md is flagged.
- `cli-entry-convergence.test.mjs` — importing a script is inert; a symlinked spelling still runs.
- `coreroot-resolver-doc-guard.test.mjs` — the plugin-root resolver block in the startup protocol.
- `dev-leakage-guard.test.mjs` — the leak scanner finds planted tokens; the shipped tree is clean.
- `fixture-cold-clean.test.mjs` — checked-in fixtures carry no cache files.
- `guard-consolidation.test.mjs` — duplication ratchets.
- `guard-read-invariants.test.mjs` — every reader hides retired and invalidated units.
- `hygiene-strategies-doc-guard.test.mjs` — hygiene reference uses retire, not delete.
- `install-doc-guard.test.mjs` — install guide matches shipped skills and hooks.
- `manifest-parity.test.mjs` — the two plugin manifests agree on identity.
- `memory-view-consent-doc.test.mjs` — one consent contract on every surface.
- `orphan-detector.test.mjs` — reachability rules; the real tree has no orphans.
- `project-read-integrity.test.mjs` — a partial PROJECT.md read is reported.
- `refocus-doc-guard.test.mjs` — `/refocus` skill contract and size budget.
- `self-managed-close-doc-guard.test.mjs` — close and maintenance ordering in protocol prose.
- `shipped-surface-inventory-guard.test.mjs` — docs and counts match the shipped tree.
- `startup-doc-contract.test.mjs` — startup protocol paths and visible-failure markers.
- `startup-extraction.test.mjs` — extracted startup sub-file exists and is indexed.

### A5. Session close and lifecycle (16)

- `backfill-memory.test.mjs` — sessions closed without memory processing are listed; corrupt receipts counted.
- `close-finish-owner.test.mjs` — who may finish a close; lock and marker checks.
- `close-hook-decision.test.mjs` — SessionEnd decision logic.
- `close-hook-regression-parent-sha.test.mjs` — a duplicate-close defect shown at an old commit and gone at the tip.
- `close-index-path-validation.test.mjs` — an index path outside the trusted home is ignored.
- `close-pass.test.mjs` — close CLI: self-test, detect, owed operations.
- `close-pass-hook.test.mjs` — the close hook's spawn boundary and skip receipts.
- `close-payload.test.mjs` — deterministic close record and UTF-8 clipping.
- `close-privacy.test.mjs` — capture gates and storage for close artifacts.
- `close-process-request.test.mjs` — the automatic close is reachable and does not repeat work.
- `close-session-identity.test.mjs` — exact-session close receipts.
- `codex-hook-path.test.mjs` — Codex hook wrapper and manifest.
- `lifecycle-detect.test.mjs` — store-state detection and baseline adoption.
- `maintenance-run.test.mjs` — the maintenance pass: index regeneration, ledger, narration.
- `session-id-binding.test.mjs` — the session id comes from the harness.
- `session-start-hook.test.mjs` — autostart skill authority gate.

### A6. Store writers, authorship boundary, unit integrity (19)

- `capture-custody.test.mjs` — capture records must physically live in the project.
- `check-inbox.test.mjs` — inbox block validation.
- `check-units.test.mjs` — unit schema and edge integrity.
- `compact-project.test.mjs` — PROJECT.md compaction.
- `decorate-graph.test.mjs` — wikilink block decoration.
- `demote-moves.test.mjs` — demoting stale moves.
- `demote-state-narrative.test.mjs` — demoting stale state bullets.
- `frontmatter-flat.test.mjs` — the flat frontmatter parser.
- `hot-section.test.mjs` — the hot section writer and its stamps.
- `impact-trace.test.mjs` — downstream impact over depends-on edges.
- `lib-cache-custody.test.mjs` — cache files that are links or FIFOs are refused.
- `stamp-written-bytes.test.mjs` — a stamp claims only the bytes written.
- `state-cache.test.mjs` — the stamp cache; absent, corrupt and unreadable are different.
- `state-cache-custody.test.mjs` — the cache must be the project's own file.
- `state-cache-release-consumers.test.mjs` — a failed lock release keeps the completed result.
- `store-ignores.test.mjs` — generated files are git-ignored from the first write.
- `text-truncate.test.mjs` — safe truncation of multi-byte text.
- `unit-vocab.test.mjs` — one shared status and type vocabulary.
- `user-authorship-boundary.test.mjs` — writers refuse to overwrite user edits.

### A7. Project state, identity, migration, one-folder mode (23)

- `adopt-foreign-state.test.mjs` — adopting state restored from another install.
- `adopt-restore-continuity.test.mjs` — adoption keeps history and archives originals.
- `canary-ownership.test.mjs` — a canary is removed only by its own project.
- `capture-gate-read-failure.test.mjs` — gate defaults under unreadable state.
- `configure-project.test.mjs` — project setup and health checks.
- `import-agent-notes.test.mjs` — one-time copy of agent notes into the project.
- `in-project-state.test.mjs` — per-project state: migration, two harnesses, auto-close resolution.
- `index-registry.test.mjs` — the project registry: register, touch, refusals.
- `legacy-cache-import.test.mjs` — importing an older cache baseline.
- `live-state-no-account-write.test.mjs` — live state never replaces files outside the project.
- `migrate-workspace-state.test.mjs` — legacy state classification for migration.
- `migration-pointer-warning.test.mjs` — an unresolved pointer stays visible.
- `moved-state-repoint.test.mjs` — a moved project keeps its records; a copy does not.
- `one-account-home.test.mjs` — the account home comes from the OS, not HOME.
- `project-only.test.mjs` — one-folder mode end to end.
- `project-slug.test.mjs` — path-to-slug encoding.
- `project-state.test.mjs` — project root resolution.
- `read-paths-mint-nothing.test.mjs` — read paths create no identity.
- `receipt-history-no-outside-write.test.mjs` — historical receipts outside the project are not written to.
- `resolve-plugin-root.test.mjs` — plugin root and authority classification.
- `state-folder-rename-open-handle.test.mjs` — state folder rename with an open handle.
- `state-no-project-place.test.mjs` — writers with no project place refuse; no account fallback.
- `trusted-home.test.mjs` — trusted-home resolution and path containment.

### A8. Metrics storage, privacy, export (11)

- `metrics-adoption-contract.test.mjs` — capture gate defaults and opt-outs.
- `metrics-artifact-permissions.test.mjs` — round folders, logs and packages are owner-only.
- `metrics-disclosure.test.mjs` — the one-time capture notice.
- `metrics-export-allowlist.test.mjs` — unknown fields never reach the export.
- `metrics-init.test.mjs` — metrics storage scaffold, storage path, purge.
- `metrics-init-wirein.test.mjs` — the scaffold is wired into startup.
- `metrics-package.test.mjs` — the anonymized package: leak scan, deltas, unavailable sources.
- `metrics-package-move.test.mjs` — a copy is hash-verified before the source is removed.
- `metrics-package-report.test.mjs` — the report says why deltas are missing.
- `metrics-privacy-failclosed.test.mjs` — a capture-disabled marker beats an opt-in.
- `metrics-project-scratch.test.mjs` — scratch folders are local and cleaned.

### A9. Locks, atomic writes, logging, small utilities (8)

- `file-lock.test.mjs` — lock acquire, contention, verified release.
- `file-lock-exhaustion.test.mjs` — lock scan exhaustion and recovery.
- `fs-atomic.test.mjs` — atomic write and temp-file cleanup.
- `hardware-budget.test.mjs` — hardware class thresholds.
- `hook-log.test.mjs` — hook log path rules and append.
- `lock-release-outcome.test.mjs` — a failed release does not lose the result.
- `log-event.test.mjs` — event append; missing project is a no-op.
- `project-hook-log.test.mjs` — project-local hook receipts.

### A10. Harness contracts and generators (5)

- `contract-format.test.mjs` — contract parse and hash.
- `contract-generator.test.mjs` — contract parsing and generation errors.
- `generate-harness-md.test.mjs` — harness file generation and missing-contract policy.
- `harness-output-preservation.test.mjs` — a hand-written harness file is not overwritten.
- `migrate-to-contract.test.mjs` — building a contract draft from harness files.

### A11. Artifacts and viewer (5)

- `artifact-identity.test.mjs` — content identity of a release tree.
- `artifact-provenance-no-index-write.test.mjs` — a dirty check never touches the git index.
- `memory-view-watch.test.mjs` — the memory-view change detector.
- `render-browse-artifact.test.mjs` — the memory-browse page generator.
- `render-metrics-artifact.test.mjs` — the `/metrics` page generator; hatched empty states.

### A12. Test infrastructure and release gates (5)

- `fs-confine.test.mjs` — negative controls for the file-access gate.
- `real-home-guard.test.mjs` — the real-home snapshot check detects adds, changes and removals.
- `require-green-candidate.test.mjs` — the tag gate's verdicts.
- `run-suite-isolated.test.mjs` — the isolated runner's negative and positive controls.
- `verify-release-identity.test.mjs` — the source-stamp gate.

### Helpers (4)

- `dev-leakage-guard.mjs` — the leak scanner itself.
- `fs-confine.mjs` — the file-access gate.
- `registered-project-fixture.mjs` — registers a throwaway project for tests.
- `trusted-test-tmp.mjs` — a shared temp root inside the trusted home, plus capability probes for tests.

---

## Appendix B — commands I ran

All runs used this wrapper: `env -i PATH=… HOME=<tmp> USERPROFILE=<tmp> TMPDIR=<tmp> CORE_TEST_ACCOUNT_HOME=<tmp> NODE_OPTIONS="--import file:///home/user/core-plugin/tests/helpers/account-home-preload.mjs" node …`, from a temporary empty folder. A check run printed `userInfo home` and `HOME` both under the temporary folder.

**T1. Runner check.** `node --test TS/prose-eval.test.mjs TS/retrieve-precision.test.mjs TS/startup-doc-contract.test.mjs`

```
# precision@3=0.850 recall@3=1.000
# N=2: precision=0.850 recall=1.000
# N=3: precision=0.850 recall=1.000
# N=5: precision=0.850 recall=1.000
# tests 15
# pass 15
# fail 0
# skipped 0
# duration_ms 181.312001
```

**C1. Test counts.** `ls *.test.mjs | wc -l` → 176. `grep -hcE '^\s*(test|it)\(' *.test.mjs` summed → 2190. `grep -ho -E '(^|[^A-Za-z0-9_.])test\(' *.test.mjs | wc -l` → 2216. Skip markers → 158.

**C2. Line counts.** Shown in Section 7.3.

**C3. Measurement scripts.** My list of 37 files summed with `cat … | wc -l` → 13774. The 16 named instruments → 6580.

**E1. Capture that never worked.** A temp project with one unit and 30 `per-turn-hook` rows in `_sessions/2026-11-08/retrieval-log.jsonl`. No evidence rows. No scorecard.

```
E1a  metrics-tripwires.mjs <project>            → (no output)                      [exit=0]
E1b  metrics-check.mjs <project> --answers      →
     Memory health — proj-e1                           checked never
     Is it storing the right memories?    not yet measured — evidence is being captured; grading runs with regular maintenance.
     Is it loading them when you need?    not yet measured — grading needs captured evidence first.
     Does it pass its own blind test?     not yet run — a blind test round has not been graded for this project.
     …
     Nothing needs your attention right now.                                       [exit=0]
E1c  hindsight-judge.mjs <project>              → {"judged":0,"skipped":0,"verdicts":{}}   [exit=0]
E1d  scorecard.mjs <project> --pin              → {"pinned":false,"reason":"nothing-new"}  [exit=0]
E1f  maintenance-run.mjs <project>              → Kept memory current: regenerated indexes + summary index. Heads up: self-test round authoring is due (no registered round exists yet (cold start)) — schedule a fresh blind round; capped to once per week.   [exit=0]
E1g  metrics-tripwires.mjs again                → (no output)                      [exit=0]
```

**E2. `validate.mjs`.**

```
E2a  no test files                → No tests found in …/_memories/_validation/tests/      [exit=0]
E2b  test with `expected:` key    → [PASS] P=1 R=1 -- what color are the gadgets          [exit=0]
E2c  project path does not exist  → No tests found in …                                   [exit=0]
E2d  no argument                  → Usage: node validate.mjs <project-path>               [exit=1]
```

**E3. Orphan detector.**

```
E3a  --core-root plugins/core →
     orphan-detector — 99/100 scripts reachable
       ~ orphan-detector.mjs — The reachability gate itself — …  ⚠ REVIEW OVERDUE — re-justify or wire/retire
     No un-allowlisted orphans. File-level reachability holds (1 allowlisted exception carried, each with a reason above); function-level wiring is not checked here.   [exit=0]
E3b  --core-root <missing folder> →
     orphan-detector — 0/0 scripts reachable
     No un-allowlisted orphans. File-level reachability holds; function-level wiring is not checked here.   [exit=0]
```

**E4. Calibration worksheet.** One synthetic turn per state through the shipped `classifyTurn`, then the shipped `exportWorksheet`.

```
worksheet has heuristic_state field: false
{"ladder_walk":false}                                                          => sealed prediction: tier-0-win
{"ladder_walk":true}                                                           => sealed prediction: tier-1-3-win
{"term":"DC-104","found":"context","context_excerpt":null}                     => sealed prediction: rec-fail-tier-0
{"term":"DC-104","found":"disk","ladder_walk":false,"disk_excerpt":null}       => sealed prediction: rec-fail-tier-1-3-trigger
{"term":"DC-104","found":"disk","ladder_walk":true,"ladder_empty":true,"disk_excerpt":null} => sealed prediction: mechanics-failure
{"term":"Frobnicator-9","found":"nowhere"}                                     => sealed prediction: capture-miss
distinct evidence signatures: 6 of 6 rows
```

**E5. Self-test rounds through the CLI**, on a copy of `obligation3-store` (6 active units).

```
Round 1: two literal questions.
  Round 1 REGISTERED and FROZEN.   counts: literal:2   (five "under the round quota" warnings)
  Self-test round 1 — 2 questions over 6 units
  headline (ranking R@10): 100%
  old-vs-new delta: none yet — this is the first round; the detector needs a prior round

Round 2: one value, one category, one abstention with no trap list.
  Self-test round 2 — 3 questions over 6 units
  headline (ranking R@10): 0%
    value         0%
    category      0%
  old-vs-new delta (overfitting detector): ↓ -100 pts vs the older rounds' mean (100%)
    (a big positive delta — new questions much harder than old — can mean the store was tuned to the old set)
  results JSON: {"headline":0,"old_vs_new":{"priors":[{"round":1,"headline":1}],"prior_mean":1,"delta":-1,"skipped":false},"n_queries":3,"forbiddenRate":null,"byKind":{"value":{"r10":0},"category":{"r10":0}}}

E5b: round 1's frozen answer key replaced with an invalid one, then `run 2`:
  old-vs-new delta: none yet — this is the first round; the detector needs a prior round

E5c: round 2's frozen answer key replaced with one easy question, then `run 2`:
  Self-test round 2 — 1 questions over 6 units
  corpus 18f042c2891d… · question-set a571ac411321…
  headline (ranking R@10): 100%
  prereg sha: a571ac411321 | record.prereg_goldset_sha256: a571ac411321 | manifest.gold_sha256 (actual file): 1b81de3fd388
```

**E6. Instruments with missing input.**

```
E6a  analyze-retrieval-skip (store has no high-signal terms; transcript: user asks about widgets, agent answers "They are red.")
     retrieval-skip: CLEAN
       memory-dependent turns: 0 | candidate skips: 0                              [exit=0]
     --json: "termsTracked": 0, "status": "CLEAN"
E6b  analyze-retrieval-skip, no transcript → retrieval-skip: UNKNOWN / transcript unavailable — cannot judge retrieval ordering   [exit=0]
E6c  audit-memory-boundary, no native file → memory-boundary: 0 native-only candidate(s) / 0 sampled of 0 native entries          [exit=0]
E6d  classify-turns, no transcript         → classify-turns [PROVISIONAL — not calibrated] UNAVAILABLE                            [exit=0]
E6e  metrics-detectors, no transcript      → metrics-detectors: UNAVAILABLE (transcript unavailable)                              [exit=0]
E6f  metrics-rollup                        → metrics not stored: unregistered                                                     [exit=0]
E6g  calibrate-classifier --check          → calibrate-classifier: ○ PROVISIONAL / pool: 0 turns | labeled: 0 | precision: n/a / No trusted calibration data is available.   [exit=1]
E6h  analyze-retrieval-quality, no logs    → No retrieval events found … Safe: unknown … Action: collect-retrieval-evidence      [exit=0]
E6i  analyze-retrieval-quality, no folder  → error: … is not a directory                                                          [exit=2]
```

**E8. Retrieval harness.**

```
E8a  no gold set                 → gold set not found: …/_tests/retrieval-gold-set.json           [exit=1]
E8b  gold given, store path does not exist →
     store: 0 active units · gold: 1 queries
     K as fraction of store: 5=Infinity%  10=Infinity%  30=Infinity%  100=Infinity%
     arm       R@5   R@10  R@30  R@100  MRR   forbid@10
     lexical   0.00 0.00 0.00 0.00  0.00    —
     ranking   0.00 0.00 0.00 0.00  0.00    —
     context3    —     —     —     —    0.00    —
     bm25      0.00 0.00 0.00 0.00  0.00    —
     escalated — (no reasoner configured)                                           [exit=0]
E8c  gold given, empty folder    → same table of zeros                              [exit=0]
E8d  one-unit store              → K as fraction of store: 5=500%  10=1000% …; every arm 1.00; context3 row all dashes except MRR   [exit=0]
E8f  --tier-policies, store missing → P0 … P3_w0.6 each "0   0"                     [exit=0]
E8g  gold missing `rung`         → Error: q1: rung '(missing)' not in {…} — evaluator fails closed   [exit=1]
E8h  empty gold set              → Error: gold set is empty                         [exit=1]
```

**E9. `metrics-check.mjs`, full view.**

```
E9a  empty folder    → MECHANICS: MACHINERY WORKING, NO STORE … Gold-set snapshot [░░░░░░░░░░] not-evaluated …   [exit=0]
E9b  project from E1 → MECHANICS: HEALTHY
     Telemetry capture        direct   30 typed events / 1 days; closure denominator unavailable; T1 100%/T2 0%/T3 0% mix; … 0 rejected
     Turn capture (evidence)  direct   ON — … 0 row(s) / 0 day(s), 0 of 0 writes failed. …                       [exit=0]
E9c  path does not exist → MECHANICS: DEGRADED … Round-trip proof [✗✗✗✗✗✗✗✗✗✗] proven-live FAIL                  [exit=0]
```

**E10. Count claims the inventory guard checks.** Companion-count claims found: 9 across seven files. Deprecation-shim claims found: 0. "Slash commands ship" claims found: 1.

**E11. Corrupt capture-health file, healthy pinned card.**

```
readCaptureHealth → {"attempts":0,"failures":0,"consecutive_failures":0,…,"unreadable":"not valid JSON"}
evaluateTripwires → {"healthy":true,"tripped":[]}
answer view last line → Needs your attention: health evidence is UNREADABLE — current capture health is unreadable (not valid JSON) (turn-capture-health.json). The answers above are UNKNOWN, not all-clear, until the file is repaired or removed.
```

**E12. Corrupt scorecard log** (`{not-json}`).

```
E12a metrics-tripwires.mjs <project>       → (no output)                           [exit=0]
E12b metrics-check.mjs <project> --answers → Needs your attention: health evidence is UNREADABLE — 1 of 1 row(s) in the pinned scorecard log are unreadable …   [exit=0]
E12c scorecard.mjs <project> --latest 2    → []                                    [exit=0]
E12d metrics-tripwires.mjs <missing path>  → (no output)                           [exit=0]
```

**E14. The trap-leak test scenario**, rebuilt outside the test runner.

```
register ok: true
trap_leak_rate measured in the test scenario: 0
quota changed from default: false
```

**E15. Startup checks.**

```
E15a check-context-integrity --project <missing PROJECT.md> --project-read-lines 0 → CONTEXT-COMPLETE   [exit=0]
E15c capability-probe --startup (no harness signal) → rows: 1 (PASS=0 DEGRADED=0 NOT-YET=0 UNKNOWN=1) / harness-capability-set: UNKNOWN → block (identity-unknown)   [exit=0]
E15d adversarial-run-gate (no harness signal) → "decision": "BLOCKED" … anti-anchoring-mechanism row absent   [exit=1]
```

**E16. The hindsight judge on the pipeline's own deliveries.** For each prompt I delivered exactly what `buildRetrievalTrace(prompt, store, {topN: 3})` accepts, captured it with the shipped `captureTurnEvidence`, and ran the shipped judge.

```
fixture obligation3-store -> {"judged":7,"skipped":0,"verdicts":{"hit-right":6,"noise":1}}
   hit-right  "omega speedmaster sale"          delivered= want-omega-speedmaster-on-sale-wait
   hit-right  "grail chronograph collection"    delivered= want-iconic-chronograph
   hit-right  "latest moe models to try"        delivered= try-latest-moe-qwen,note-new-google-moe-release
   hit-right  "coffee grinder burr"             delivered= distractor-coffee-grinder
   noise      "what should we do about the speedmaster discount and the heritage question"  delivered= values-heritage,want-omega-speedmaster-on-sale-wait,distractor-coffee-grinder
   hit-right  "zenith el primero on sale"       delivered= want-omega-speedmaster-on-sale-wait
   hit-right  "what's left on our agenda?"      delivered= try-latest-moe-qwen,note-new-google-moe-release
fixture nested-store -> {"judged":3,"skipped":0,"verdicts":{"noise":1,"hit-right":2}}
   noise      "alpha subsystem rollout"         delivered= dc-strong,dc-neighbor,dc-weak1
   hit-right  "quokka incident"                 delivered= obs-nested-note
   hit-right  "rollout"                         delivered= dc-strong,dc-weak1,dc-weak2
```

**After the runs.** `git status --short | grep -v " gauntlet/"` → no output. `find tests/fixtures -name _lib -o -name unit-summaries.json` → no output. `ls /root/.core` → "No such file or directory". A later commit in this run (`6464a1c`) touched only `gauntlet/` (`git diff --stat 79b526b HEAD`), so the source I read is still the tree at `79b526b`.

---

## What I did not verify

- The exact number of tests that execute, and the suite's run time. I did not run the suite.
- Behavior on Windows. I read the CI matrix; I ran nothing there.
- The `/cut-release` flow. It is not in this repo.
- The specs that thresholds cite. They are not in this repo.
- Any live project. Gaps B1 and A10 rest on code reading, not on a run against real data.
- The 150 or so test files I read by header and titles only. Their one-line descriptions in Appendix A come from those headers and titles.
