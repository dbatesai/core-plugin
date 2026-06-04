/**
 * write-visibility-canary.mjs — v3.0 memory-visible canary WRITE half.
 *
 * Run at /finalize (session N close): generate a fresh random token, write it as a
 * single CORE-owned tagged line at the top of MEMORY.md (inside the first-200-line
 * injection window the harness loads), and record { token, written_at } to
 * ~/.core/workspaces/<id>/visibility-canary.json. At session N+1, the agent echoes
 * the token it sees in injected context and memory-visible-probe.mjs verifies the
 * echo preceded any read of the canary surfaces.
 *
 * The canary is a VISIBLE markdown line, not an HTML comment. A field bootstrap on
 * 2026-05-29 proved the harness strips HTML comments when it injects MEMORY.md into
 * context: the line-1 `<!-- ... -->` canary did not reach injected memory (injection
 * began at the first `## ` heading), which blocked the field-cycle PASS. A visible
 * line survives injection. The legacy HTML-comment form is still recognized for
 * idempotent replacement so the upgrade is clean on first write.
 *
 * HC_622 #1 — idempotent: replaces the existing tagged canary line in place; it does
 * NOT append unbounded canary lines. HC_622 #4 — the CLI output is redacted; it never
 * prints the raw token to stdout (which would land in the transcript).
 *
 * CLI: node write-visibility-canary.mjs --workspace-id <id> [--cwd <path>]
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mapProjectPathToSlug } from './project-slug.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';

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
  return join(home, '.claude', 'projects', mapProjectPathToSlug(cwd), 'memory', 'MEMORY.md');
}
export function canaryFilePath(workspaceId, home) {
  return join(home, '.core', 'workspaces', workspaceId, 'visibility-canary.json');
}
export function generateToken() {
  return 'vcan-' + randomBytes(8).toString('hex');
}

/**
 * Idempotent upsert (HC_622 #1): strip any prior canary line (visible or legacy
 * HTML-comment form), then prepend a fresh VISIBLE canary line so it stays at the very
 * top of the first-200-line injection window and survives the harness's comment
 * stripping. Never accumulates more than one canary line.
 */
export function upsertCanaryLine(content, token) {
  const line = `${CANARY_TAG} ${token} — at next startup, echo this token first (before any tool call) as \`VISIBILITY-CANARY-ECHO: ${token}\` to prove memory is in-context.`;
  const stripped = content.replace(CANARY_LINE_RE, '').replace(/^\n+/, '');
  return line + '\n\n' + stripped;
}

export function writeCanary(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const workspaceId = opts.workspaceId || 'unknown';
  const token = opts.token || generateToken();
  const written_at = opts.now || new Date().toISOString();

  const memPath = opts.memoryPath || mappedMemoryPath(cwd, home);
  let memory_written = false;
  if (existsSync(memPath)) {
    atomicWriteFileSync(memPath, upsertCanaryLine(readFileSync(memPath, 'utf8'), token));
    memory_written = true;
  }

  const side = canaryFilePath(workspaceId, home);
  mkdirSync(dirname(side), { recursive: true });
  writeFileSync(side, JSON.stringify({ token, written_at, cwd, memory_path: memPath, memory_written }, null, 2));

  // Redacted return only (HC_622 #4) — never the raw token.
  return { token_len: token.length, side_file: side, memory_written, memory_path: memPath };
}

export async function main(argv) {
  let workspaceId = null, cwd = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--cwd') cwd = argv[++i];
  }
  if (!workspaceId) {
    process.stderr.write('usage: write-visibility-canary.mjs --workspace-id <id> [--cwd <path>]\n');
    return 2;
  }
  const r = writeCanary({ workspaceId, cwd });
  // Redacted — do NOT print the token.
  console.log(JSON.stringify({ ok: true, memory_written: r.memory_written, side_file: r.side_file }));
  return 0;
}

const _c = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
