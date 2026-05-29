/**
 * memory-visible-probe.mjs — v3.0 memory-visible-in-agent-context (Claude Code).
 *
 * Proves, mechanically where possible, that the auto-memory the harness injects at
 * session start was actually IN the agent's context — not merely present on disk
 * (that's v2.7's auto-memory-injection probe). The proof is a per-session canary:
 * /finalize writes a fresh random token into the MEMORY.md injection window and
 * records the expected token to ~/.core/workspaces/<id>/visibility-canary.json
 * (see write-visibility-canary.mjs). At the next session, the agent echoes the
 * token it sees in injected context; THIS probe parses the Claude Code transcript
 * JSONL and confirms the echo appeared BEFORE any read of the canary surfaces.
 *
 * Honest boundary (HC_620/HC_622): this proves the token was injected INTO context
 * and echoed before any read of the canary surfaces — i.e. memory was VISIBLE. It
 * does NOT prove the agent attended to or acted on memory beyond echoing the token:
 * memory-VISIBLE != memory-USED. And it is Claude-Code-specific (transcript format);
 * other harnesses need their own probe.
 *
 * Identity_status (HC-accepted bar):
 *   PASS     — token matches AND the echo precedes any protected-path read in the transcript
 *   DEGRADED — token matches but transcript unavailable/unparseable (ordering then
 *              relies on protocol), OR a protected-path read precedes the echo,
 *              OR the token is absent/mismatched in the transcript (truncation /
 *              non-injection / recognition-failure)
 *   NOT-YET  — no canary recorded (the write step hasn't run yet)
 *
 * Constraint 4 (HC_622): this probe NEVER prints the raw expected token — only a
 * redacted hash — so its own output can't leak the token into the transcript and
 * fake a future echo.
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'memory-visible-in-agent-context';

// Agent tools that count as a read when they target a protected path.
const READ_TOOLS = new Set(['Read', 'Edit', 'Grep', 'Glob']);
// Shell verbs that read a file (used when the tool is Bash).
const SHELL_READ_RE = /\b(cat|grep|egrep|fgrep|rg|sed|awk|head|tail|less|more|nl|od|xxd|strings)\b/;

/** Redact a token for safe logging — never emit the raw token (HC_622 #4). */
export function redactToken(tok) {
  if (!tok) return '(none)';
  return `len=${tok.length} sha256:${createHash('sha256').update(String(tok)).digest('hex').slice(0, 12)}`;
}

export function canaryFilePath(workspaceId, home) {
  return join(home, '.core', 'workspaces', workspaceId, 'visibility-canary.json');
}

/** The paths a pre-echo read must not touch (canary surfaces). */
export function protectedPaths(workspaceId, home, cwd) {
  const mapped = cwd.replace(/\//g, '-');
  return [
    canaryFilePath(workspaceId, home),
    join(home, '.claude', 'projects', mapped, 'memory', 'MEMORY.md'),
    'visibility-canary',
  ];
}

function resolveTranscript(cwd, home, override) {
  if (override) return existsSync(override) ? override : null;
  const mapped = cwd.replace(/\//g, '-');
  const dir = join(home, '.claude', 'projects', mapped);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  let latest = null, latestM = -1;
  for (const f of files) {
    const p = join(dir, f);
    try { const m = statSync(p).mtimeMs; if (m > latestM) { latestM = m; latest = p; } } catch { /* skip */ }
  }
  return latest;
}

/**
 * Scan transcript lines (one JSON entry per line, in order) for the canary echo
 * and any protected-path reads. Returns ordered events [{idx, kind:'echo'|'read'}].
 * Conservative (HC_622 #3): any tool_use whose serialized input references a
 * protected path counts as a read — ambiguity resolves toward 'read', which can
 * only downgrade PASS to DEGRADED, never the reverse.
 */
export function scanTranscript(lines, token, protPaths) {
  const events = [];
  lines.forEach((line, idx) => {
    if (!line || !line.trim()) return;
    let e; try { e = JSON.parse(line); } catch { return; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'text' && token && typeof c.text === 'string' && c.text.includes(token)) {
        events.push({ idx, kind: 'echo' });
      }
      if (c?.type === 'tool_use') {
        const input = c.input || {};
        const inputStr = JSON.stringify(input);
        const touchesProtected = protPaths.some((p) => inputStr.includes(p));
        if (!touchesProtected) continue;
        const isReadTool = READ_TOOLS.has(c.name);
        const isShellRead = c.name === 'Bash' && typeof input.command === 'string' && SHELL_READ_RE.test(input.command);
        // Conservative: a protected-path-referencing tool_use that is a known reader,
        // or any ambiguous Bash referencing the path, counts as a pre-echo read.
        if (isReadTool || isShellRead || c.name === 'Bash') events.push({ idx, kind: 'read', tool: c.name });
      }
    }
  });
  return events;
}

/** Pure classifier over (token, transcriptAvailable, scanned events). */
export function classify({ token, transcriptAvailable, events }) {
  if (!token) return { identity_status: 'NOT-YET', reason: 'no canary recorded — write step has not run' };
  if (!transcriptAvailable) {
    return { identity_status: 'DEGRADED', reason: 'transcript unavailable/unparseable — ordering relies on protocol, not mechanically verified' };
  }
  const firstEcho = events.find((e) => e.kind === 'echo');
  if (!firstEcho) {
    return { identity_status: 'DEGRADED', reason: 'canary token not echoed in transcript — truncation, non-injection, recognition-failure, or mismatch' };
  }
  const readBeforeEcho = events.some((e) => e.kind === 'read' && e.idx < firstEcho.idx);
  if (readBeforeEcho) {
    return { identity_status: 'DEGRADED', reason: 'a protected-path read precedes the echo — cannot mechanically exclude the read-first cheat' };
  }
  return { identity_status: 'PASS', reason: 'canary echoed from injected context before any protected-path read' };
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const workspaceId = opts.workspaceId || 'unknown';
  const observed_at = new Date().toISOString();

  // Read the expected token from the side file (script-internal read — NOT an agent tool_use).
  let token = null;
  const sideFile = canaryFilePath(workspaceId, home);
  if (existsSync(sideFile)) {
    try { token = JSON.parse(readFileSync(sideFile, 'utf8')).token || null; } catch { token = null; }
  }

  const transcriptPath = resolveTranscript(cwd, home, opts.transcriptPath);
  let transcriptAvailable = false;
  let events = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const lines = readFileSync(transcriptPath, 'utf8').split('\n');
      events = scanTranscript(lines, token, protectedPaths(workspaceId, home, cwd));
      transcriptAvailable = true;
    } catch { transcriptAvailable = false; }
  }

  const { identity_status, reason } = classify({ token, transcriptAvailable, events });
  return buildRow({ identity_status, reason, token, transcriptAvailable, events, cwd, observed_at });
}

function buildRow({ identity_status, reason, token, transcriptAvailable, events, cwd, observed_at }) {
  const evidence = [
    // NEVER the raw token — redacted hash only (HC_622 #4).
    { source: 'canary-token', value: { recorded: !!token, redacted: redactToken(token) }, agrees_with_others: !!token, weight: token ? 'primary' : 'conflicting' },
    { source: 'transcript', value: { available: transcriptAvailable, echo: events.some((e) => e.kind === 'echo'), reads_before_echo: events.some((e) => e.kind === 'read') }, agrees_with_others: identity_status === 'PASS', weight: identity_status === 'PASS' ? 'corroborating' : 'conflicting' },
    { source: 'classification', value: reason, agrees_with_others: identity_status === 'PASS', weight: identity_status === 'PASS' ? 'corroborating' : 'conflicting' },
  ];
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Memory visible in agent context — transcript-verified canary echo (in-context injection; NOT proof of use)',
    capability_kind: 'observation',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness: 'claude-code',
    cwd,
    mutation_permitted: false,
    mutation_block_reason: 'read-only-context',
    identity_status,
    evidence,
  };
}
