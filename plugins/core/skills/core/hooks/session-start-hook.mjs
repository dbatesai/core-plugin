#!/usr/bin/env node
/**
 * session-start-hook.mjs — SessionStart injection that makes CORE self-running.
 *
 * Stdout from a SessionStart hook is injected into the session as additional context. We use
 * that one window to tell the agent its first action must be `/core` — so the user never has
 * to type it. Installed → CORE bootstraps itself, manages its own memory, every session. This
 * is the front half of the self-running pair: SessionStart auto-invokes /core (this hook),
 * SessionEnd auto-discharges the close (close-pass-hook.mjs).
 *
 * Why a directive and not auto-running the skill: a hook can't invoke a skill, only inject
 * context. /core's own bootstrap dedup (startup.md §"Bootstrap dedup") makes the directive
 * safe to fire on every SessionStart event (startup/resume/clear/compact) — it won't re-run
 * if it already ran this session, and re-firing after a compaction is a feature (re-orient).
 *
 * Opt-out: CORE_AUTOSTART=0 (mirrors CORE_RETRIEVAL_HOOK / CORE_AUTO_CLOSE). A user who wants
 * to invoke /core by hand sets it and gets no injection.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Claude Code SessionStart; Codex has a
 * different session model (harnesses/codex.md) and bootstraps via its own startup mandate.
 *
 * I/O: ignores stdin; prints the directive to stdout. Always exits 0 — a startup hook must
 * never block the session opening.
 */

const DIRECTIVE = `CORE session protocol: this environment has the CORE project-intelligence plugin installed. Before anything else this session — before answering the user, before any other tool call — invoke the \`/core\` skill. It runs startup routing, loads cross-session project memory, and composes a readiness summary, and it self-deduplicates (it won't re-run if it already ran this session). Run \`/core\` first, then address the user's request.`;

function main() {
  if (process.env.CORE_AUTOSTART === '0') return 0;
  process.stdout.write(DIRECTIVE + '\n');
  return 0;
}

try { process.exit(main() || 0); } catch { process.exit(0); }
