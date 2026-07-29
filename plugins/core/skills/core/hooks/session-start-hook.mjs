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
 * Wrapper seam: CORE_AUTOSTART_SKILL names the skill the directive invokes (default /core).
 * A wrapper (e.g. BBLens) sets it to its own entry point (/bblens) and inherits this hook —
 * one guarded mechanism instead of a duplicate wrapper-local one
 * (overlay-not-fork). TWO gates, because project .claude/settings.json env is forwarded into
 * hook subprocesses: (1) shape — the value must look like /name or /plugin:name, so free
 * text never reaches the injected directive; (2) authority — a non-default skill is honored
 * only when the USER's ~/.claude/settings.json registers it (CORE_AUTOSTART_SKILL or the
 * CORE_AUTOSTART_ALLOWED_SKILLS comma list). Shape is not authority: without gate 2 an
 * untrusted repo could redirect the session's mandated first action to any installed skill
 *. Wrapper install docs: register the entry point in USER settings.
 * Either gate failing → fall back to /core (and the rejection is hook-logged).
 *
 * Ships with the plugin as prescriptive code; .mjs only. Claude Code SessionStart; Codex has a
 * different session model (harnesses/codex.md) and bootstraps via its own startup mandate.
 *
 * I/O: ignores stdin; prints the directive to stdout. Always exits 0 — a startup hook must
 * never block the session opening.
 */

import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { logHookEvent } from './hook-log.mjs';
import { trustedHome } from '../scripts/trusted-home.mjs';

// trustedHome() (shared anchor in scripts/trusted-home.mjs): the OS-account home,
// unspoofable by $HOME/$USERPROFILE. Unresolvable → null → nothing is authorized.

// Skill-name shape: /name or /plugin:name, lowercase kebab — anything else is not a skill
// reference and must not reach the directive (env is project-influenceable; see header).
const SKILL_SHAPE = /^\/[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;

/**
 * User-scope authorization for a wrapper autostart skill. Shape alone is not
 * authority: project .claude/settings.json env is forwarded into hook subprocesses,
 * so an untrusted repo could otherwise redirect the session's mandated first action
 * to ANY installed skill. A non-default skill is honored only
 * when the USER's own settings file registers it — either as the same
 * CORE_AUTOSTART_SKILL value or in a CORE_AUTOSTART_ALLOWED_SKILLS comma list.
 * Unreadable/absent user settings → not authorized (fail closed to /core).
 */
export function userAuthorizedSkills(readFile = readFileSync, home = trustedHome()) {
  try {
    if (!home) return new Set(); // no trusted home → nothing authorized (fail closed)
    const settings = JSON.parse(readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    const env = settings.env || {};
    const out = new Set();
    if (env.CORE_AUTOSTART_SKILL) out.add(String(env.CORE_AUTOSTART_SKILL));
    for (const s of String(env.CORE_AUTOSTART_ALLOWED_SKILLS || '').split(',')) {
      if (s.trim()) out.add(s.trim());
    }
    return out;
  } catch { return new Set(); }
}

export function autostartSkill(env = process.env, authorized = null) {
  const v = env.CORE_AUTOSTART_SKILL;
  if (!v || v === '/core') return '/core';
  if (!SKILL_SHAPE.test(v)) return '/core';                       // not a skill reference
  const allow = authorized ?? userAuthorizedSkills();
  if (!allow.has(v)) {
    logHookEvent({ hook: 'session-start', action: 'reject-autostart-skill', reason: 'not-user-authorized:' + v });
    return '/core';                                               // shape ≠ authority
  }
  return v;
}

export function buildDirective(skill) {
  return `CORE session protocol: this environment has the CORE project-intelligence plugin installed. Before anything else this session — before answering the user, before any other tool call — invoke the \`${skill}\` skill. It runs startup routing, loads cross-session project memory, and composes a readiness summary, and it self-deduplicates (it won't re-run if it already ran this session). Run \`${skill}\` first, then address the user's request.`;
}

function main() {
  // A session running under CORE_CLOSE_PASS_ACTIVE=1 is discharging a close and must NOT be
  // told to run /core first — it has one job. Without this, such a session takes the /core
  // directive and never cleanly closes.
  if (process.env.CORE_CLOSE_PASS_ACTIVE === '1') {
    logHookEvent({ hook: 'session-start', action: 'skip', reason: 'close-pass-child' });
    return 0;
  }
  if (process.env.CORE_AUTOSTART === '0') {
    logHookEvent({ hook: 'session-start', action: 'skip', reason: 'opt-out' });
    return 0;
  }
  const skill = autostartSkill();
  process.stdout.write(buildDirective(skill) + '\n');
  logHookEvent({ hook: 'session-start', action: 'inject', reason: skill === '/core' ? undefined : 'skill=' + skill });
  return 0;
}

// Only run as the hook entry — importing this module must not execute main() / process.exit().
const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  try { process.exit(main() || 0); } catch { process.exit(0); }
}
