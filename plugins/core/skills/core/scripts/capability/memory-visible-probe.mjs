/**
 * memory-visible-probe.mjs — v3.0 memory-visible-in-agent-context (Claude Code).
 *
 * Proves the auto-memory the harness injects at session start was actually IN the
 * agent's context — not merely present on disk (that's v2.7's auto-memory probe).
 * Per-session canary: /finalize writes a fresh token into the MEMORY.md injection
 * window and records the expected token to ~/.core/workspaces/<id>/visibility-canary.json
 * (write-visibility-canary.mjs). Next session the agent echoes the token it sees in
 * injected context; THIS probe parses the Claude Code transcript JSONL and confirms
 * the echo preceded any tool that could read the canary.
 *
 * Honest boundary (HC_620/622/623): proves the token was injected into context and
 * echoed before any potentially-reading tool — memory was VISIBLE. It does NOT prove
 * the agent attended to / acted on memory beyond the echo (memory-VISIBLE != memory-USED),
 * and it's Claude-Code-specific.
 *
 * Identity_status (HC-accepted bar, hardened per HC_623):
 *   PASS     — canary recorded AND actually present in the MEMORY.md injection window
 *              (memory_written + file still contains the token) AND echoed in the
 *              transcript AND no non-allowlisted tool ran before the echo.
 *   DEGRADED — canary recorded but not in MEMORY.md (echo couldn't prove injection),
 *              OR transcript unavailable/unparseable, OR token not echoed, OR a
 *              non-allowlisted tool ran before the echo (could have read the canary).
 *   NOT-YET  — no canary recorded (write step hasn't run).
 *
 * HC_623 hardening: (1) require memory injection, not just an echo; (2) before the
 * echo, ANY tool_use outside a tiny allowlist degrades — a Bash can read hidden
 * surfaces without a literal path, so path-matching alone is too weak.
 * HC_622 #4: never print the raw expected token — redacted hash only.
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'memory-visible-in-agent-context';
export const DEFAULT_INJECTION_LINE_WINDOW = 200;
// Byte cap on the injected MEMORY.md window. Field-observed (session 56, 2026-05-30):
// Claude Code's startup warning displays "limit: 24.4KB" and renders a 25,684-byte file
// as "25.7KB" — decimal KB (÷1000), so the cap is 24,400 bytes, NOT 24.4×1024. A file can
// sit UNDER the 200-line window yet OVER this byte cap (196 lines / 25.7KB that session),
// truncating silently while a line-only probe falsely PASSes. Byte + line = defense-in-depth.
export const DEFAULT_INJECTION_BYTE_WINDOW = 24400;

// Tools that cannot read the canary surfaces, so they're safe before the echo.
// Deliberately tiny (HC_623 #2): everything else degrades PASS conservatively.
export const ECHO_SAFE_TOOLS = new Set(['Skill']);

/** Redact a token for safe logging — never emit the raw token (HC_622 #4). */
export function redactToken(tok) {
  if (!tok) return '(none)';
  return `len=${String(tok).length} sha256:${createHash('sha256').update(String(tok)).digest('hex').slice(0, 12)}`;
}

export function canaryFilePath(workspaceId, home) {
  return join(home, '.core', 'workspaces', workspaceId, 'visibility-canary.json');
}

function resolveWorkspaceId(cwd) {
  try {
    const wsPath = join(cwd, 'workspace.json');
    if (existsSync(wsPath)) return JSON.parse(readFileSync(wsPath, 'utf8')).workspace_id || null;
  } catch { /* fall through */ }
  return null;
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
 * Scan ordered transcript lines for the canary echo and every tool_use (by name).
 * No path-matching (HC_623 #2): the classifier judges tools by the allowlist, since
 * a Bash command can read protected surfaces without a literal path in its input.
 */
export function scanTranscript(lines, token) {
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
      if (c?.type === 'tool_use') events.push({ idx, kind: 'tool', name: c.name });
    }
  });
  return events;
}

/** Pure classifier (HC_623-hardened bar). */
export function classify({ token, memoryWritten, memoryHasToken, transcriptAvailable, events, memoryLineCount = null, injectionLineWindow = DEFAULT_INJECTION_LINE_WINDOW, memoryByteCount = null, injectionByteWindow = DEFAULT_INJECTION_BYTE_WINDOW }) {
  if (!token) return { identity_status: 'NOT-YET', reason: 'no canary recorded — write step has not run' };
  // Blocker 1: an echo only proves injection if the canary actually landed in the
  // injected memory window. Without that, PASS would prove transcript echo, not memory.
  if (!memoryWritten || !memoryHasToken) {
    return { identity_status: 'DEGRADED', reason: 'canary not present in the MEMORY.md injection window — an echo cannot prove injection' };
  }
  // Blocker 1b: a line-1 canary proves visibility, not load-completeness. If the
  // memory file exceeds the known injection window, the tail can drop silently while
  // the canary still echoes. That is DEGRADED, never PASS. The window is enforced on
  // BOTH axes — Claude Code truncates on whichever limit it hits first, and a file can
  // be under the line window yet over the byte cap (field-observed session 56).
  if (Number.isFinite(memoryLineCount) && Number.isFinite(injectionLineWindow) && memoryLineCount > injectionLineWindow) {
    return { identity_status: 'DEGRADED', reason: `truncation-detected: MEMORY.md line_count=${memoryLineCount} exceeds injection window=${injectionLineWindow}` };
  }
  if (Number.isFinite(memoryByteCount) && Number.isFinite(injectionByteWindow) && memoryByteCount > injectionByteWindow) {
    return { identity_status: 'DEGRADED', reason: `truncation-detected: MEMORY.md byte_count=${memoryByteCount} exceeds injection byte window=${injectionByteWindow}` };
  }
  if (!transcriptAvailable) {
    return { identity_status: 'DEGRADED', reason: 'transcript unavailable/unparseable — ordering relies on protocol, not mechanically verified' };
  }
  const firstEcho = events.find((e) => e.kind === 'echo');
  if (!firstEcho) {
    return { identity_status: 'DEGRADED', reason: 'canary token not echoed — truncation, non-injection, recognition-failure, or mismatch' };
  }
  // Blocker 2: before the echo, ANY tool outside the tiny allowlist could have read
  // the canary (a Bash needs no literal path). Conservative: degrade.
  const badPreEcho = events.find((e) => e.kind === 'tool' && e.idx < firstEcho.idx && !ECHO_SAFE_TOOLS.has(e.name));
  if (badPreEcho) {
    return { identity_status: 'DEGRADED', reason: `pre-echo tool '${badPreEcho.name}' could have read the canary before the echo — cannot mechanically exclude the read-first cheat` };
  }
  return { identity_status: 'PASS', reason: 'canary present in MEMORY.md, echoed from injected context before any non-allowlisted tool' };
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const workspaceId = opts.workspaceId || resolveWorkspaceId(cwd) || 'unknown';
  const observed_at = new Date().toISOString();

  // Read expected token + injection facts from the side file (script-internal read).
  let token = null, memoryWritten = false, memoryPath = null;
  const sideFile = canaryFilePath(workspaceId, home);
  if (existsSync(sideFile)) {
    try {
      const s = JSON.parse(readFileSync(sideFile, 'utf8'));
      token = s.token || null;
      memoryWritten = s.memory_written === true;
      memoryPath = s.memory_path || null;
    } catch { token = null; }
  }

  // Blocker 1: verify the token is actually in the MEMORY.md injection window now.
  let memoryHasToken = false, memoryLineCount = null, memoryByteCount = null;
  if (token && memoryWritten && memoryPath && existsSync(memoryPath)) {
    try {
      const memoryContent = readFileSync(memoryPath, 'utf8');
      memoryHasToken = memoryContent.includes(token);
      memoryLineCount = countLines(memoryContent);
      memoryByteCount = Buffer.byteLength(memoryContent, 'utf8');
    } catch {
      memoryHasToken = false;
      memoryLineCount = null;
      memoryByteCount = null;
    }
  }
  const injectionLineWindow = opts.injectionLineWindow || DEFAULT_INJECTION_LINE_WINDOW;
  const injectionByteWindow = opts.injectionByteWindow || DEFAULT_INJECTION_BYTE_WINDOW;

  const transcriptPath = resolveTranscript(cwd, home, opts.transcriptPath);
  let transcriptAvailable = false, events = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    try { events = scanTranscript(readFileSync(transcriptPath, 'utf8').split('\n'), token); transcriptAvailable = true; } catch { transcriptAvailable = false; }
  }

  const { identity_status, reason } = classify({ token, memoryWritten, memoryHasToken, transcriptAvailable, events, memoryLineCount, injectionLineWindow, memoryByteCount, injectionByteWindow });
  return buildRow({ identity_status, reason, token, memoryWritten, memoryHasToken, memoryLineCount, injectionLineWindow, memoryByteCount, injectionByteWindow, transcriptAvailable, events, cwd, observed_at });
}

// Count REAL lines. A trailing newline produces a final empty split element that is
// NOT a real line — so a file of exactly N lines ending in `\n` must count as N, not
// N+1, or it falsely trips truncation at an N-line injection window (HC blocker #3,
// evt-202605291319). Live relevance: MEMORY.md sits near the 200-line window after the
// v2.8.1 compaction, so the off-by-one was one compaction away from a false DEGRADED.
// Exported for direct boundary testing.
export function countLines(content) {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function buildRow({ identity_status, reason, token, memoryWritten, memoryHasToken, memoryLineCount, injectionLineWindow, memoryByteCount, injectionByteWindow, transcriptAvailable, events, cwd, observed_at }) {
  const lineOver = Number.isFinite(memoryLineCount) && Number.isFinite(injectionLineWindow) && memoryLineCount > injectionLineWindow;
  const byteOver = Number.isFinite(memoryByteCount) && Number.isFinite(injectionByteWindow) && memoryByteCount > injectionByteWindow;
  const loadComplete = !(lineOver || byteOver);
  const evidence = [
    { source: 'canary-token', value: { recorded: !!token, redacted: redactToken(token) }, agrees_with_others: !!token, weight: token ? 'primary' : 'conflicting' },
    { source: 'memory-injection', value: { memory_written: memoryWritten, token_in_memory_file: memoryHasToken }, agrees_with_others: memoryWritten && memoryHasToken, weight: (memoryWritten && memoryHasToken) ? 'corroborating' : 'conflicting' },
    { source: 'memory-load-completeness', value: { line_count: memoryLineCount, injection_line_window: injectionLineWindow, byte_count: memoryByteCount, injection_byte_window: injectionByteWindow, truncation_axis: lineOver ? 'line' : (byteOver ? 'byte' : null), status: loadComplete ? 'within-window-or-unmeasured' : 'truncation-detected' }, agrees_with_others: loadComplete, weight: loadComplete ? 'corroborating' : 'conflicting' },
    { source: 'transcript', value: { available: transcriptAvailable, echo: events.some((e) => e.kind === 'echo') }, agrees_with_others: identity_status === 'PASS', weight: identity_status === 'PASS' ? 'corroborating' : 'conflicting' },
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
