#!/usr/bin/env node
/**
 * project-slug.mjs — canonical project-path → identity-slug encoding.
 *
 * Claude Code maps a project cwd to ~/.claude/projects/<slug>/memory/MEMORY.md
 * where <slug> is the absolute path with path separators AND dots replaced by '-'.
 * Confirmed on a dotted corporate username: a home dir like `/Users/<first.last>`
 * encodes to `-Users-<first-last>-...` (the dot becomes a hyphen).
 *
 * The previous inline encoders only replaced '/' (`path.replace(/\//g, '-')`), so a
 * username containing a dot produced `-Users-<first.last>-...` — a slug that never
 * matched the real folder. Two confirmed failures from that single gap:
 *   - generate-memory-index's cross-project guard false-refused (MEMORY.md priority
 *     block could not auto-refresh; manual fix every finalize).
 *   - write-visibility-canary could not locate the right MEMORY.md, returning
 *     memory_written: false so the next-session visibility check never fired.
 *
 * Every site that turns a project path into a Claude-projects identity slug must use
 * this one function so the encoding can't drift again. Handles POSIX '/', Windows
 * '\\', '.', and the Windows drive colon ':' — a path segment can't contain a colon
 * on Windows, so a slug that leaves `C:` in produces an un-creatable directory. If a future case
 * shows Claude also transforms another character (e.g. spaces on cloud-sync paths),
 * add it here — one place, one rule.
 *
 * The plugin ships Node.js (.mjs) only.
 */

import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function mapProjectPathToSlug(p) {
  return String(p).replace(/[/\\.:]/g, '-');
}

/**
 * resolveMemoryProjectRoot — the directory Claude Code keys AUTO-MEMORY on.
 *
 * Transcripts live under the cwd slug, but MEMORY.md lives under the slug of the git
 * worktree root. A project folder inside a larger repository (a home-directory repo is
 * the common case) therefore shares `~/.claude/projects/<root-slug>/memory/` with every
 * sibling in that repository, and a cwd-derived slug names a folder the harness never
 * injects. Confirmed 2026-09-13 on a home-level repo: the harness announced
 * `-Users-<user>/memory/` while every CORE memory script wrote to and measured
 * `-Users-<user>-Documents-Projects-<proj>/memory/` — a false CONTEXT-PARTIAL every
 * session, and a visibility canary planted where the agent could never see it.
 *
 * Returns `cwd` unchanged (same spelling) when it is itself the worktree root, doesn't
 * exist, isn't inside a git worktree, or git isn't available — in all of those the cwd
 * slug is the harness's own answer. Only memory-path callers use this;
 * `read-transcript.mjs` keeps the cwd slug on purpose.
 */
export function resolveMemoryProjectRoot(cwd) {
  const dir = String(cwd);
  if (!existsSync(dir)) return dir;
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim();
    if (!top || realpathSync(top) === realpathSync(dir)) return dir;
    return top;
  } catch {
    return dir;
  }
}

/** Slug of the auto-memory folder: the git-root slug, or the cwd slug outside a repo. */
export function mapMemoryProjectPathToSlug(cwd) {
  return mapProjectPathToSlug(resolveMemoryProjectRoot(cwd));
}

/**
 * slugify — generic filename-safe slug for an arbitrary string (lowercase, non-
 * alphanumerics collapsed to single dashes, trimmed). Lives here so slug logic stays
 * centralized (the guard-consolidation ratchet). Distinct from mapProjectPathToSlug,
 * which preserves path structure; this one flattens to `[a-z0-9-]`. Used by the
 * mailbox for message filename fields (from / topic).
 */
export function slugify(s, fallback = 'unknown') {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}
