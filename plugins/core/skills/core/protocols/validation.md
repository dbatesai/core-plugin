# Validation

## Voice

Plain person voice — same standard as SKILL.md §Voice.

---

Read this when you're about to run the validation regime — weekly automatic via memory hygiene, or on-demand when retrieval feels off.

The regime tests three things: that the substrate is healthy (units findable, frontmatter parsing, edges resolving), that retrieval converges on the right candidates, and that the priority function ranks them right. Failure surfaces as either a quality signal (precision/recall thresholds) or a structural signal (parse errors, missing files).

## What the regime tests

The validation corpus is a YAML file per test at `<project>/_memories/_validation/tests/test-*.yaml`. Each test names a query and the units the query should surface. The runner executes the query against the live retrieval ladder (or a simulated Tier 1, for fast smoke tests) and scores precision + recall against the expected list.

Four classes of test:

- **Assumption tests** — does retrieval actually pull the expected unit when a known-anchor query runs?
- **User-control tests** — does a deleted PROJECT.md fact stay deleted on next render? Does a retired unit not resurrect?
- **Convergence tests** — does the retrieval ladder converge before Tier 3 escalation on queries that should hit Tier 1 or Tier 2?
- **Storage-anomaly tests** — do all units parse? Do edges resolve to existing units? Do inverse edges hold?

## Test corpus format

Each test is a YAML file with frontmatter:

```yaml
---
query: "what is the priority function formula"
expected_memories:
  - dc-69-priority-function
forbidden_memories: []
tier_expected: 1
notes: "Should match dc-69 via 'priority' + 'function' + 'formula' terms."
---
```

Fields:

- `query` — string. The query as the agent would phrase it internally.
- `expected_memories` — list of unit ids (no `.md` extension). The retrieval should pull these.
- `forbidden_memories` — list of unit ids. These should NOT appear in the candidate set.
- `tier_expected` — integer 1/2/3. Which retrieval tier should resolve the query. Tier 0 (in-context) is the trivial case and isn't tested.
- `notes` — string. Free-text rationale for the test author.

## Runner

The runner is at `<plugin-root>/skills/core/scripts/validate.mjs`. Resolve `<plugin-root>` the way `protocols/startup.md` does — from the skill base directory, reusing the `CORE_ROOT` startup resolved this session — because `${CLAUDE_PLUGIN_ROOT}` is not reliably injected into agent Bash tool calls. The `${CLAUDE_PLUGIN_ROOT}` form below is shorthand for that resolved root; substitute the concrete path. Invocation:

```
node ${CORE_ROOT}/skills/core/scripts/validate.mjs <project-path>
```

The runner walks `<project-path>/_memories/_validation/tests/test-*.yaml`, runs each test, scores precision and recall, writes a report to `<project-path>/_outputs/validation/<YYYY-MM-DD>/REPORT.md`, and exits with status 0 on pass / 1 on any FAIL.

Two scripts get loosely called "the validator," and they do different jobs. `check-units.mjs` checks unit schema and edge integrity — the store check `/finalize` runs at every close. `validate.mjs`, this runner, simulates retrieval against the test corpus and scores precision and recall. When a protocol says "validate the store," that means `check-units.mjs`; this file owns the retrieval suite.

The current runner simulates Tier 1 retrieval (OR-of-terms grep) only, and it is **NOT the product retrieval path** — the shipped retriever is `retrieve-context.mjs` (title ∪ body-BM25 over the recursive index, the same function the per-turn hook and the measurement harness call). The runner's numbers are retrieval-health diagnostics; never cite them as product baselines or use them to clear a release gate (`retrieval-harness.mjs` is the product-path instrument). A test with `tier_expected: 2` or `3` is outside what the runner can verify — a unit reachable only via edge walk scores FAIL here even though real retrieval would find it. Those FAILs are not authoritative; handle them per §"Failure handling" step 2, and exclude them from the all-tests-failing substrate-broken signal. Future versions migrate the simulator to the product ranking (a ceremony-scoped change, since it breaks historical comparability). The thresholds and report shape stay constant across versions.

## Thresholds

For each test, the verdict:

- **PASS** — both precision ≥ 0.8 and recall ≥ 0.8.
- **INVESTIGATE** — both ≥ 0.5 but at least one < 0.8. Surface but don't block.
- **FAIL** — precision < 0.5 or recall < 0.5. Pause-and-surface trigger.

Aggregate pass rate is reported alongside individual results.

## Output

`<project-path>/_outputs/validation/<YYYY-MM-DD>/REPORT.md` contains:

- Headline: aggregate pass/investigate/fail counts.
- Per-test result table: status, precision, recall, query (truncated).
- Detail section: each query, expected units, retrieved (top 5), and any forbidden hits.

## Cadence

- **Weekly automatic** — fires from memory hygiene's comprehensive pass at the first `/finalize` of each calendar week.
- **On-demand** — user can request a run any time, or the agent can self-trigger when retrieval starts feeling off.
- **Auto-on for retrieval-tuning sessions** — when you're adjusting priority weights or edge structure, validation runs before and after to measure the delta.

## Failure handling

When a test fails:

1. **Re-examine the test.** Is the `expected_memories` list correct? Did the expected unit get archived since the test was written? Has the unit's prefix or slug changed?
2. **Check `tier_expected`.** The runner simulates Tier 1 only. If the test specifies `tier_expected: 2` or `3`, the FAIL is expected, not evidence of breakage: perform the walk yourself — start from the Tier 1 hits, follow `supersedes` / `depends-on` edges one hop (Tier 2), or run the Explore subagent (Tier 3) — and record the manual result in the report as INVESTIGATE with a note (`manual-tier-2: reached` or `not-reached`). Exclude these tests from the aggregate FAIL count when deciding whether to pause-and-surface.
3. **Mark INVESTIGATE in the report**, document the gap, and continue — don't block the build on a single test failure unless it represents systemic substrate breakage.
4. **If ALL tests fail < 0.5**, that's the substrate-broken signal. Pause-and-surface to the user with the report path.

The autonomous-first contract from the execution plan applies: try autonomous resolution first; surface only when the failure mode is genuinely blocking.

## User's subjective read

Quantitative thresholds aren't the whole story. The validation report includes a final field: *"Did retrieval feel right in real use?"* The user's subjective experience is data — if the numbers say 90% pass but conversations felt thin, the regime is missing something. Surface the subjective read in the next hygiene retrospective.

## Extending the corpus

When you notice a retrieval miss in real conversation that the corpus didn't catch, add a test:

```yaml
---
query: "<the query as you ran it>"
expected_memories: [<what should have surfaced>]
forbidden_memories: []
tier_expected: <which tier>
notes: "Added <date> after observing miss in <session>."
---
```

The corpus grows organically. The continuous self-evaluation loop in `protocols/self-evolution.md` feeds back into corpus growth — every observed retrieval failure becomes a test.
