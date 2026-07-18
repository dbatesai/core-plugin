---
name: harness-codex
description: Concrete tool mapping for each abstract adapter verb when CORE runs inside Codex CLI, including documented drops for capabilities Codex doesn't deliver.
---

# Harness adapter — Codex CLI

## detect-harness

Detect by:
- `~/.codex/` config directory present, OR
- `$CODEX_HOME` env var set, OR
- Skill discovered under a Codex user-scope skill path (`~/.codex/skills/`, `~/.agents/skills/`, or a plugin cache under `~/.codex/plugins/cache/`), OR
- Absence of Claude-Code-specific tools (`TaskCreate`, `SendMessage`, `TeamCreate`).

If any of these conditions hold, harness is Codex.

## spawn-subagent

Use Codex's subagent invocation surface. Custom agents can be defined at `~/.codex/agents/<name>/`. For ad-hoc exploration, invoke the general agent with the prompt verbatim. Subagent output returns inline.

**Schema note (2026-06-09, unvalidated):** the concrete tool is `spawn_agent` (see the nickname note below), but its parameter schema has not been re-verified against a live Codex CLI install since the May 2026 GA churn. Before the first spawn of a session, inspect the installed Codex tool definition for the actual tool name, required params, and result shape. The verb-level intent is stable — pass the brief verbatim as the prompt, read the result inline — even if field names moved. Treat any parameter shape written here as a starting hypothesis, not a contract, until a live install validates it.

Codex's `spawn_agent` tool may return its own generated nickname (e.g., `Dalton`, `Bohr`) for the subagent invocation. That nickname is at the tool-instance layer — Codex's bookkeeping — not the CORE identity layer. The CORE identity lives in the brief, the log filename, and what the agent calls itself in its own narrative. Ignore the returned nickname for CORE purposes; the file-scratchpad filename is the authoritative identity surface.

## spawn-team

Codex has no team primitive. Use the **file-scratchpad pattern**:

1. Create the scratchpad directory: `<project>/_sessions/<date>/<name>/`.
2. For each agent in `agents`, write a brief at `<scratchpad>/<agent-name>-brief.md` containing base-protocol + role + the team-wide context.
3. Spawn each agent in sequence (or in parallel via Codex's subagent feature). Each agent reads its own brief PLUS any prior agents' output logs in the scratchpad before producing its own.
4. Each agent writes its output to `<scratchpad>/<agent-name>-log.md`.
5. The orchestrating agent reads all logs and synthesizes.

Anti-anchoring discipline: the Critic's brief explicitly says "write your initial frame to `<scratchpad>/<critic-name>-frame.md` BEFORE reading any generator output." This is the file-system equivalent of the in-prompt instruction the Claude Code adapter uses. Trust the agent to honor it.

## send-message

Append to a file: `<scratchpad>/<from>-to-<to>-<UTC-timestamp>.md` with the message body. The recipient agent reads its inbox (files starting with `*-to-<self>-*.md` newer than its last read) on each turn.

## await-completion

Poll the scratchpad. The completion signal is the presence of `<scratchpad>/<from>-complete.md` (or a `status: complete` line in the agent's log file). Implicit polling cadence: every turn, the waiting agent checks before proceeding.

## plan-task

Codex's `update_plan` takes a list of step objects keyed by a step identifier with a `status` field (current shape: `{step, status}` — verify against the installed Codex CLI's tool schema, since this surface has churned across May 2026 GA). Map `plan-task` to a single `update_plan` call seeding all steps with status `"pending"`. Subsequent `complete-task` calls update specific steps. If the schema doesn't match, inspect the Codex tool definition and adapt — the verb-level intent (seed all steps as pending, mutate one to completed on each tick) is stable; only the field names move.

## complete-task

Call `update_plan` with the same plan, mutating the step at id `id` to status `"completed"`. Codex re-renders the plan on each call.

## notify-user

**DROPPED** on Codex. In-conversation alerts only — the agent surfaces the message in its turn output and the user sees it when reading the session. No mid-turn notifications, no shell-out to ntfy/osascript. CORE on Codex is a synchronous, in-conversation-only product.

## schedule

**DROPPED** on Codex. CORE on Codex is synchronous and user-driven; no scheduled work runs in the background. Protocols that would normally schedule something (e.g., "check the deploy in 30 minutes") instead surface a "run this manually next time" reminder in conversation. If a user genuinely wants scheduled CORE work, they're on Claude Code.

## close-pass (self-managed session close)

**Exit-hook discharge DROPPED** on Codex; **startup catch-up is the equivalent** (same correctness, later timing — spec 2026-06-29 §9). On Claude Code a SessionEnd hook spawns a detached `claude -p "/finalize"` at session end, so the close runs itself. Codex has no validated SessionEnd hook that can spawn a surviving background process (see `hook-register` below), so there is no exit-hook close. Instead, every Codex startup runs the catch-up path (`startup.md §"Startup catch-up"`): `close-pass.mjs detect` finds an owed or partial close from last session and discharges the remainder before readiness. The per-op marker + single-flight lock + three-state detection are harness-agnostic — they work identically; only the *trigger* differs (Codex: next startup; Claude Code: session end). The user can still run `/finalize` manually any time. Re-open this drop if a live Codex install validates a SessionEnd-equivalent hook that can spawn a detached process.

## hook-register

**DROPPED for pre-execution blocking** on Codex pending empirical validation.

Codex hooks went GA in May 2026. The public docs detail thread-lifecycle and turn-lifecycle contributor hooks but do not detail pre-execution blocking semantics. The skill-edit PWD guard (and any other hook expected to block a tool call before execution) becomes agent-self-discipline on Codex — the agent reads the PWD requirement from `protocols/data-storage.md` and complies; no harness-level enforcement.

Re-open this drop once a live Codex CLI install validates whether Codex hooks can:
1. Block pre-execution.
2. Inject context like Claude Code's `additionalContext`.
3. Run at the events CORE needs (PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit).

**Post-answer outcome close: REGISTERED, source-verified against the documented contract, and installed-and-proven at exact SHA `8e941de6` (2026-07-18) — re-proof owed at each subsequent candidate, not permanently settled.** The earlier framing here — "Codex has no validated Stop-equivalent" — was itself stale: Hale's fresh audit (2026-07-17, second round) cited the official Codex contract directly ([plugin hook contract](https://developers.openai.com/codex/plugins/build#bundled-mcp-servers-and-lifecycle-hooks), [Stop event contract](https://developers.openai.com/codex/hooks#stop)), independently confirmed in this session: Codex supports turn-scoped `UserPromptSubmit` and `Stop` events, both carrying `session_id` and a Codex-native `turn_id`; plugin-bundled hooks receive `PLUGIN_ROOT`/`PLUGIN_DATA` env vars (`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as compatibility aliases); a plugin registers hooks via an explicit `"hooks"` manifest field or Codex's automatic `./hooks/hooks.json` discovery.

CORE now ships `hooks/hooks-codex.json` (registered via `.codex-plugin/plugin.json`'s explicit `"hooks"` field, deliberately not relying on the automatic-discovery default — that default resolves to the SAME path as Claude Code's `hooks/hooks.json`, which would risk Codex silently picking up Claude-only hook files) wiring `UserPromptSubmit` → `retrieve-context-hook-codex.mjs` and `Stop` → `answer-close-hook-codex.mjs`. Both are thin wrappers (pure JS, no shell env-var-prefix tricks — those don't work on Windows) that set `CORE_HOOK_HARNESS=codex` explicitly before delegating to the shared `retrieve-context-hook.mjs` / `answer-close-hook.mjs` implementations, which read Codex's `turn_id` as the real answer-turn identity instead of Claude Code's `prompt_id`. Harness identity is never inferred from ambient env vars for hooks reached through these wrappers — that was the earlier defect (`CODEX_SESSION_ID`/`CODEX_PLUGIN_ROOT` as undocumented, unreliable signals), and it's now an explicit, authoritative one instead.

**What is proven and what isn't, named plainly:** two independent installed-Codex proofs at exact SHA `8e941de6eeb1f6fbe78483cd2e1302edef81d4a0` (2026-07-18) confirm the whole chain works end to end on a real Codex CLI: `git archive` at the exact SHA into a temporary marketplace, hook trust cleared (`--dangerously-bypass-hook-trust` for the vetted probe, no persistent trust decision written), two real turns each producing `retrieve-context:delivered:ok` → `answer-close:closed:ok` with a genuine native Codex `turn_id`, a joined outcome row, and clean rollback (the real `core@core` stable install never touched). Raw hashed bundles: `CORE/_outputs/2026-07-18/8e941de-codex-proof-bundle/` and the independently-built `core-codex/_outputs/2026-07-18/8e941de-codex-proof-bundle/`. **What isn't proven: this exact chain at any SHA newer than `8e941de6`** — plumbing proof doesn't carry forward automatically across commits, even test-only ones, and needs re-running at whatever candidate is current. Also unproven: the earlier claim that this step is "not buildable from a Claude Code session with no Codex CLI" turned out to be false once actually checked — a real Codex CLI (`codex`, Homebrew-installed) is directly invocable via Bash from a Claude Code session on the same machine; the constraint was assumed, not verified. Until each new candidate is reproven, the fallback inferred-closure path inside `retrieve-context-hook.mjs` remains a real, honest safety net — for a session where the Stop hook didn't fire for any reason, on either harness, not specifically because Codex "can't" support one.

## read-auto-memory

Codex can inject memory-like context at session start when `features.memories = true` (experimental). When it does, the context is gated by `no_memories_if_mcp_or_web_search = true` and may be suppressed depending on session configuration. Treat any injected memory as harness-local recall — scratch cache, not project truth. Verify project-specific claims against the CORE unit store before acting. Startup probe, concretely: pick one fact you'd expect injected (the most recent session's one-line summary, or a canary-tagged line if one exists) and check whether it is already in your context *without reading any file*. Present → injection occurred; treat it as scratch cache. Absent → treat injection as not-occurred this session and rely on the CORE unit store alone; do not read the memory file to simulate injection.

Startup context also comes from `<project>/AGENTS.md` and `~/.codex/AGENTS.md`; treat those as instruction surfaces, not project memory. Project facts live in `<project>/PROJECT.md` and `<project>/_memories/`.

Codex assistant memory under `~/.codex/memories/` is harness-local recall, level 5 in the five-level authority ordering at `protocols/data-storage.md §"Authority ordering"`. Codex memory writes are not part of normal CORE project curation. Write project observations to `<project>/_memories/observations/...`. Codex memory is the explicit-save surface; mechanics live in `save-recall-note` below. CORE does not encode trigger phrases for when to invoke it — that's install-level configuration in the user's `AGENTS.md`.

## save-recall-note

Write the provided content as one ad hoc note to:

```
~/.codex/memories/extensions/ad_hoc/notes/<timestamp>-<slug>.md
```

- `<timestamp>` is UTC ISO-8601 compact form, e.g. `20260521T173801Z`
- `<slug>` is a short kebab-case description, e.g. `core-codex-probe-observations`

Do not edit any existing Codex memory file or index. Codex's own memory system manages those.

The verb writes only to the Codex recall surface. If the content is also project-canonical (a real observation about the project, not a workflow hint), write a CORE observation to `<project>/_memories/observations/<YYYY-MM>/` separately as part of normal autonomous curation per `protocols/data-storage.md`. The two writes are not duplicates — the Codex note is recall-shaped (workflow hint), the CORE observation is project-shaped (graduates into units under hygiene).

After writing, acknowledge the save to the user in plain voice — name the path.

What belongs on this surface (per DC-86):
- Cross-session workflow lessons
- User preferences for assistant behavior
- Harness-specific empirical findings
- Pointers to canonical project artifacts
- Short summaries of prior session outcomes useful as warm-start hints

What does NOT (also per DC-86):
- Project facts of record (those go to `PROJECT.md` and `_memories/`)
- Decision units, risk units, person units
- Anything the agent infers should be retired (anti-resurrection applies to recall too)

## configure-project

Codex has no startup-mandate hook the way Claude Code does, so a returning Codex session on a CORE folder confirms the install by running the `/configure-project` skill (or its script directly). It is the Codex-side counterpart to Claude Code's startup mandate: it resolves `CORE_ROOT`, confirms the manifests + skill dir + this adapter are present, runs the workspace fork-check in detect-only mode (per DC-104, a path already registered is a *returning* workspace regardless of which harness registered it — Codex opening a Claude-managed folder is not a fork), validates the `_memories/` store, reports configured-vs-session-live connector capability, runs the capability probe, and generates `AGENTS.md` from `CONTRACT.md` when one exists.

Run it as the setup step on a folder, or any time you want a "is this project wired correctly under Codex?" check:

```bash
# Derive PLUGIN_ROOT from the loaded SKILL.md path (the `${CLAUDE_PLUGIN_ROOT}`
# rule below). The script self-resolves CORE_ROOT too, but pass --core-root for safety.
# Run from the project directory and OMIT --project — the script defaults to the
# process cwd. ($(pwd) is bash-only: PowerShell evaluates it to a PathInfo object
# and the argument breaks silently.)
node "<PLUGIN_ROOT>/skills/core/scripts/configure-project.mjs" --core-root "<PLUGIN_ROOT>" --harness codex
# Not in the project directory? Pass --project with an absolute literal path.
# --apply to actually write AGENTS.md (needs a CONTRACT.md); --json for the structured report
```

It is idempotent and report-only unless `--apply` is passed. Echo both tiers of the receipt honestly — the script-visible rows are facts; the session-live rows (is a configured connector reachable+authed *this session*? the `~/.codex/config.toml` server list, which the script does not parse; the live two-harness check) are questions only the running session can answer. Never restate a session-live question as a script-asserted fact. Full behavioral contract: `skills/configure-project/SKILL.md`.

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Codex's `read`, `write`, `apply_patch`, `shell` + `find`, `shell` + `rg`, `shell`, MCP-server or `shell` + `curl`, MCP-server (Brave / Firecrawl) respectively. No explicit mapping needed.
- The plugin ships dual manifests (`.claude-plugin/plugin.json` for Claude Code, `.codex-plugin/plugin.json` for Codex) in the same repo; Codex installs the bundle into `~/.codex/plugins/cache/<marketplace>/core/<version>/` via `codex plugin marketplace add` + `codex plugin add`. Skill content under `skills/core/` is shared between both harnesses. The manifests are intentionally asymmetric: the Claude manifest carries `build` (startup's readiness line reads it — single source of truth), the Codex manifest carries `skills` and `interface` (Codex marketplace requirements with no Claude Code equivalent). Name/version/license/author must always agree — `tests/scripts/manifest-parity.test.mjs` enforces it.
- Voice baseline catalog ships empty initially. Build empirically if usage warrants.

### Known RTK collisions on Codex

- **File existence test:** `rtk test -f <path>` collides with the shell `test` builtin and produces noisy usage output. Use `rtk sh -c '[ -f <path> ]'` instead.
- **Grep with directory exclusion:** `rtk grep --exclude-dir=...` is not supported. Use `rg -g '!<dir>/**'` (or `rtk sh -c 'rg -g ...'`) instead.
- **`rtk find` flag passthrough is incomplete.** Standard `find` flags like `-print` and other GNU-find extensions don't always pass through cleanly. When you need specific find behavior, fall back to `rtk sh -c 'find ...'` so the find binary sees its flags directly.

These are RTK-specific, not Codex-specific — but they're worth listing here because Codex sessions tend to use shell more heavily than Claude Code sessions and hit these patterns more often.

### Nested `codex exec` and AGENTS.md discipline

When a Codex slash command spawns nested `codex exec` calls inside its own shell flow (CORE's `/finalize` and `/process-memory` do this when running scripts), the nested call inherits the caller's environment but may not always surface the project's `AGENTS.md` instructions to the inner agent — including project-level RTK guidance. The Round-4 probe surfaced this: outer probe runs honored RTK; CORE-on-Codex shell calls inside the same session did not consistently.

If you're authoring a slash-command flow that spawns nested `codex exec`, do not assume the inner invocation has inherited the project's command discipline. Pass project conventions explicitly into the nested prompt — name the RTK requirement, name any project-specific shell rules — rather than relying on AGENTS.md inheritance.

### `${CLAUDE_PLUGIN_ROOT}` is not set on Codex

Codex doesn't set `${CLAUDE_PLUGIN_ROOT}`. Companion skills that need to invoke scripts in the sibling core skill (`/finalize`, `/process-memory`) must derive the path from the loaded SKILL.md location rather than relying on the env var.

The mechanical rule mirrors the protocol-resolution rule used in `skills/finalize/SKILL.md` and `skills/process-memory/SKILL.md`: take the absolute path you loaded SKILL.md from, replace `/skills/<wrapper>/SKILL.md` with `/skills/core/scripts/<script>.mjs`, and invoke that. Concretely:

- Claude Code marketplace install: `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<script>.mjs` works because the env var is set.
- Codex plugin-cache install: derive the path from the loaded `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/<wrapper>/SKILL.md`, replace `/skills/<wrapper>/SKILL.md` with `/skills/core/scripts/<script>.mjs`.

Don't construct paths against a guessed plugin base. The loaded path carries the resolution.
