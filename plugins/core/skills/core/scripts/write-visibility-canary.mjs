/**
 * write-visibility-canary.mjs — memory-visible canary WRITE half.
 *
 * Run at /finalize (session N close): generate a fresh random token, write it as a
 * single CORE-owned tagged line at the top of MEMORY.md (inside the first-200-line
 * injection window the harness loads), and record the token, the session that wrote
 * it, and its unspent state to ~/.core/workspaces/<id>/visibility-canary.json. At
 * session N+1, the agent echoes the token it sees in injected context and
 * memory-visible-probe.mjs verifies the echo preceded any read of the canary surfaces,
 * then spends the token — one token proves one session.
 *
 * The canary is a VISIBLE markdown line, not an HTML comment. The harness
 * strips HTML comments when it injects MEMORY.md into
 * context (injection begins at the first `## ` heading), so an HTML-comment
 * canary never reaches injected memory; a visible
 * line survives injection. The legacy HTML-comment form is still recognized for
 * idempotent replacement.
 *
 * Idempotent: replaces the existing tagged canary line in place; it does
 * NOT append unbounded canary lines. The CLI output is redacted; it never
 * prints the raw token to stdout (which would land in the transcript).
 *
 * CLI: node write-visibility-canary.mjs --workspace-id <id> [--cwd <path>] [--session-id <id>]
 *
 * By design the script ships with the plugin. The plugin ships .mjs only.
 */

import { existsSync, readFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mapProjectPathToSlug } from './project-slug.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';

export const CANARY_TAG = 'CORE-VISIBILITY-CANARY';
// M16: match only the MANAGED canary line, not any prose that mentions the tag. The old
// `/^.*CORE-VISIBILITY-CANARY\b.*$/gm` deleted every line containing the literal — including
// documentation that explains the canary mechanism (this self-referential project's own
// memory surfaces carry such prose). Two anchored shapes, never a bare-tag mention:
//   1. The managed visible line: starts with the tag + a token, and carries the
//      `VISIBILITY-CANARY-ECHO` instruction (the exact template upsertCanaryLine writes).
//   2. The legacy form: a full `<!-- ... CORE-VISIBILITY-CANARY ... -->` HTML-comment line.
// Prose like "the CORE-VISIBILITY-CANARY proves memory is in-context" matches neither.
const CANARY_LINE_RE = /^(?:<!--.*CORE-VISIBILITY-CANARY.*-->|CORE-VISIBILITY-CANARY\s+\S+.*VISIBILITY-CANARY-ECHO).*$\n?/gm;

export function mappedMemoryPath(cwd, home) {
  // Forward-slash join (not path.join) — Claude Code's projects-folder slug uses '/'
  // and the cross-platform tests expect it; Node's fs accepts forward slashes on Windows.
  return [home, '.claude', 'projects', mapProjectPathToSlug(cwd), 'memory', 'MEMORY.md'].join('/');
}
export function canaryFilePath(workspaceId, home) {
  return join(home, '.core', 'workspaces', workspaceId, 'visibility-canary.json');
}
export function canaryLockPath(workspaceId, home) {
  return join(home, '.core', 'workspaces', workspaceId, 'visibility-canary.lock');
}
export function generateToken() {
  return 'vcan-' + randomBytes(8).toString('hex');
}

// The expected token is the whole proof. Anyone who can read it can echo it without
// ever having had memory injected, so the record is owner-only, as is the directory
// holding it.
const EVIDENCE_FILE_MODE = 0o600;
const EVIDENCE_DIR_MODE = 0o700;

function writeEvidenceFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: EVIDENCE_DIR_MODE });
  try { chmodSync(dirname(path), EVIDENCE_DIR_MODE); } catch { /* pre-existing dir, other owner */ }
  atomicWriteFileSync(path, JSON.stringify(value, null, 2));
  try { chmodSync(path, EVIDENCE_FILE_MODE); } catch { /* filesystem without POSIX modes */ }
}

function readEvidenceFile(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Idempotent upsert: strip any prior canary line (visible or legacy
 * HTML-comment form), then prepend a fresh VISIBLE canary line so it stays at the very
 * top of the first-200-line injection window and survives the harness's comment
 * stripping. Never accumulates more than one canary line.
 */
export function upsertCanaryLine(content, token) {
  const line = `${CANARY_TAG} ${token} — at next startup, echo this token first (before any tool call) as \`VISIBILITY-CANARY-ECHO: ${token}\` to prove memory is in-context.`;
  const stripped = content.replace(CANARY_LINE_RE, '').replace(/^\n+/, '');
  return line + '\n\n' + stripped;
}

/**
 * Write a fresh canary for the next session.
 *
 * MEMORY.md is read, rewritten, and recorded as one transaction under the workspace's
 * canary lock. Atomic replacement alone only prevents torn bytes: two closes racing
 * each read the same content, and the loser's canary line replaces the winner's while
 * the side file still names the winner's token, leaving a workspace whose recorded
 * expectation cannot be echoed.
 */
export function writeCanary(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const workspaceId = opts.workspaceId || 'unknown';
  const token = opts.token || generateToken();
  const written_at = opts.now || new Date().toISOString();
  const written_by_session = opts.sessionId || null;
  const memPath = opts.memoryPath || mappedMemoryPath(cwd, home);
  const side = canaryFilePath(workspaceId, home);

  const memory_written = withFileLock(canaryLockPath(workspaceId, home), () => {
    if (!existsSync(memPath)) return false;
    atomicWriteFileSync(memPath, upsertCanaryLine(readFileSync(memPath, 'utf8'), token));
    return true;
  }, opts.lockOpts);

  writeEvidenceFile(side, {
    token, written_at, written_by_session, cwd,
    memory_path: memPath, memory_written,
    // A token is spent once. Recording who spent it is what makes a replay visible.
    consumed_at: null, consumed_by_session: null,
  });

  // Redacted return only — never the raw token.
  return { token_len: token.length, side_file: side, memory_written, memory_path: memPath };
}

/**
 * Spend the recorded canary token for one session. The token proves memory injection
 * exactly once: after it is spent, the same value echoed by any later session is a
 * replay of a value that is now readable from the transcript, not fresh evidence.
 * Re-entry from the SAME session is idempotent, so a probe can run twice in a session
 * without inventing a replay.
 *
 * Returns { consumed, reason?, consumed_by_session? }. Never throws on a missing or
 * unreadable record — the caller decides what an unrecorded consumption means.
 */
export function consumeCanary(workspaceId, opts = {}) {
  const home = opts.home || homedir();
  const sessionId = opts.sessionId || null;
  const side = canaryFilePath(workspaceId, home);
  try {
    return withFileLock(canaryLockPath(workspaceId, home), () => {
      const state = readEvidenceFile(side);
      if (!state || !state.token) return { consumed: false, reason: 'no-canary-recorded' };
      if (state.consumed_by_session != null) {
        return state.consumed_by_session === sessionId
          ? { consumed: true, consumed_by_session: sessionId }
          : { consumed: false, reason: 'already-consumed', consumed_by_session: state.consumed_by_session };
      }
      writeEvidenceFile(side, {
        ...state,
        consumed_at: opts.now || new Date().toISOString(),
        consumed_by_session: sessionId,
      });
      return { consumed: true, consumed_by_session: sessionId };
    }, opts.lockOpts);
  } catch {
    return { consumed: false, reason: 'consumption-unrecordable' };
  }
}

export async function main(argv) {
  let workspaceId = null, cwd = null, sessionId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--session-id') sessionId = argv[++i];
  }
  if (!workspaceId) {
    process.stderr.write('usage: write-visibility-canary.mjs --workspace-id <id> [--cwd <path>] [--session-id <id>]\n');
    return 2;
  }
  const r = writeCanary({ workspaceId, cwd, sessionId });
  // Redacted — do NOT print the token.
  console.log(JSON.stringify({ ok: true, memory_written: r.memory_written, side_file: r.side_file }));
  return 0;
}

const _c = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
