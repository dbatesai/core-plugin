#!/usr/bin/env node
/**
 * project-slug.mjs — canonical project-path → identity-slug encoding.
 *
 * Claude Code maps a project cwd to ~/.claude/projects/<slug>/memory/MEMORY.md
 * where <slug> is the absolute path with path separators AND dots replaced by '-'.
 * Confirmed on a dotted corporate username: `/Users/David.Bates28/...` encodes to
 * `-Users-David-Bates28-...` (the dot becomes a hyphen).
 *
 * The previous inline encoders only replaced '/' (`path.replace(/\//g, '-')`), so a
 * username containing a dot produced `-Users-David.Bates28-...` — a slug that never
 * matched the real folder. Two confirmed failures from that single gap:
 *   - generate-memory-index's cross-project guard false-refused (MEMORY.md priority
 *     block could not auto-refresh; manual fix every finalize).
 *   - write-visibility-canary could not locate the right MEMORY.md, returning
 *     memory_written: false so the next-session visibility check never fired.
 *
 * Every site that turns a project path into a Claude-projects identity slug must use
 * this one function so the encoding can't drift again. Handles POSIX '/', Windows
 * '\\', '.', and the Windows drive colon ':' — a path segment can't contain a colon
 * on Windows, so a slug that leaves `C:` in produces an un-creatable directory (the
 * drive-colon class the v3.8.0 Windows-portability pass addressed). If a future case
 * shows Claude also transforms another character (e.g. spaces on cloud-sync paths),
 * add it here — one place, one rule.
 *
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

export function mapProjectPathToSlug(p) {
  return String(p).replace(/[/\\.:]/g, '-');
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
