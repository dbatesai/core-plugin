/**
 * read-transcript.mjs — `read-transcript` adapter verb (deterministic core).
 *
 * Transcript introspection is
 * portable across harnesses but with different on-disk paths
 * and JSONL schemas. Per the central principle, native specifics live in the adapter
 * layer, not core prose — so this script resolves a transcript path per harness and
 * normalizes the lines into one ordered event shape that consumers (memory-accessed,
 * retrieval-skip detection, anti-anchoring ordering proofs) can read uniformly.
 * Selection is bound to the requesting project and prefers exact session identity;
 * mtime-latest applies only within that project and is recorded in
 * meta.transcript_resolution.
 *
 * Schemas verified on disk (evidence, not assumption):
 *   - claude-code: ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session>.jsonl
 *       message lines carry `message.content[]` with {type:'text'|'tool_use', ...}.
 *   - codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *       lines are {timestamp, type, payload}; the leading line is type 'session_meta'
 *       carrying {id, cwd} — the project identity; type 'response_item' + payload.type
 *       'message' carry {role, content:[{type, text}]}; payload.type 'reasoning' is
 *       encrypted (skipped); 'event_msg' carries agent_message/user_message/etc.
 *
 * Codex tool/shell extraction: function_call (exec_command
 * etc.; `arguments` is a JSON string with cmd + paths) and custom_tool_call (apply_patch
 * etc.; `input` is a string with the patch/paths) are surfaced as `tool` events with
 * name + input text — the file-access signal memory-accessed needs. Schema derived from a
 * real `rollout-*.jsonl` (meta `codex_tool_extraction: 'implemented'`). *_output return
 * values and encrypted reasoning are skipped (access-intent lives in the call, not the
 * return). Residual: the evidence rollout is one Codex build; HC verifies the schema
 * still matches current core-codex transcripts — if a Codex version drifts the field
 * names, fix-forward (the parser fails open to no-tool-events, never throws).
 *
 * By design the deterministic parse ships as a script; the plugin ships .mjs.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mapProjectPathToSlug } from './project-slug.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const SUPPORTED_HARNESSES = new Set(['claude-code', 'codex']);

/**
 * Resolve the transcript for a harness, with the resolution method made explicit.
 *
 * Selection is bound to the requesting project. A transcript that cannot be shown to
 * belong to `cwd` is never returned — the resolver reports UNKNOWN (path null, with a
 * reason) rather than handing back whichever session happens to be newest on the box.
 *
 * mtime-latest selection alone is also a race: if a NEW session for the same project
 * starts before the analyzers run, every derived metric reads the wrong session. So
 * exact session identity wins where it exists — the claude-code transcript filename IS
 * the session id (explicit sessionId arg, else CLAUDE_CODE_SESSION_ID), and a codex
 * rollout carries its thread id in the leading `session_meta` line (explicit sessionId
 * arg, else CODEX_THREAD_ID / CODEX_SESSION_ID). mtime is the documented fallback
 * WITHIN the project, never across projects; consumers see which one applied in
 * meta.transcript_resolution and weigh trust accordingly.
 *
 * Returns { path, resolution, reason } — resolution ∈ 'override' | 'session-id'
 * | 'mtime-fallback' | null; reason ∈ 'override-missing' | 'no-project-transcript'
 * | 'unsupported-harness' | null.
 */
export function resolveTranscript(harness, { cwd = process.cwd(), home = homedir(), override = null, sessionId = null, env = process.env } = {}) {
  // An override is the caller naming an exact file; that is explicit authority, not selection.
  if (override) {
    return existsSync(override)
      ? { path: override, resolution: 'override', reason: null }
      : { path: null, resolution: null, reason: 'override-missing' };
  }
  if (harness === 'claude-code') {
    // The project slug directory IS the project binding — nothing outside it is a candidate.
    const dir = join(home, '.claude', 'projects', mapProjectPathToSlug(String(cwd)));
    const sid = sessionId || env.CLAUDE_CODE_SESSION_ID || null;
    if (sid) {
      const exact = join(dir, `${sid}.jsonl`);
      if (existsSync(exact)) return { path: exact, resolution: 'session-id', reason: null };
    }
    const latest = latestFile(dir, (f) => f.endsWith('.jsonl'));
    return latest
      ? { path: latest, resolution: 'mtime-fallback', reason: null }
      : { path: null, resolution: null, reason: 'no-project-transcript' };
  }
  if (harness === 'codex') {
    // rollout-*.jsonl nested under YYYY/MM/DD — walk the sessions tree, then keep only
    // rollouts whose own session_meta names this project. A rollout with no readable
    // identity stays out: unattributable is UNKNOWN, not "close enough".
    const candidates = filesRecursive(join(home, '.codex', 'sessions'), (f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const want = canonicalPath(cwd);
    const sid = sessionId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
    let newestForProject = null;
    for (const c of candidates) {
      const identity = readCodexIdentity(c.path);
      if (!identity || canonicalPath(identity.cwd) !== want) continue;
      if (sid && identity.id === sid) return { path: c.path, resolution: 'session-id', reason: null };
      if (!newestForProject) newestForProject = c.path;
    }
    return newestForProject
      ? { path: newestForProject, resolution: 'mtime-fallback', reason: null }
      : { path: null, resolution: null, reason: 'no-project-transcript' };
  }
  return { path: null, resolution: null, reason: 'unsupported-harness' };
}

/** Back-compat path-only resolver. Prefer resolveTranscript for new callers. */
export function resolveTranscriptPath(harness, opts = {}) {
  return resolveTranscript(harness, opts).path;
}

/** Compare paths by their resolved form so symlinked or unnormalized cwds still match. */
function canonicalPath(p) {
  const s = String(p ?? '');
  try { return realpathSync(s); } catch { return resolve(s); }
}

// A codex rollout's leading session_meta line carries the thread id and the cwd it ran
// in. That line is large (it embeds base instructions), so read a bounded head rather
// than the whole multi-megabyte transcript just to learn who it belongs to.
const IDENTITY_HEAD_BYTES = 1 << 20;

/** Read a codex rollout's { id, cwd } identity. Null when the file does not declare one. */
export function readCodexIdentity(path) {
  const line = readFirstLine(path);
  if (!line) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (e?.type !== 'session_meta') return null;
  const cwd = e?.payload?.cwd;
  if (typeof cwd !== 'string' || !cwd) return null;
  return { id: typeof e?.payload?.id === 'string' ? e.payload.id : null, cwd };
}

function readFirstLine(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, IDENTITY_HEAD_BYTES);
    if (want <= 0) return null;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(want);
    const n = readSync(fd, buf, 0, want, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl !== -1) return text.slice(0, nl);
    return n >= size ? text : null; // truncated head — not a parseable line
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

function latestFile(dir, pred) {
  if (!existsSync(dir)) return null;
  let latest = null, latestM = -1;
  for (const f of readdirSync(dir)) {
    if (!pred(f)) continue;
    const p = join(dir, f);
    try { const m = statSync(p).mtimeMs; if (m > latestM) { latestM = m; latest = p; } } catch { /* skip */ }
  }
  return latest;
}

function filesRecursive(root, pred) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!pred(e.name)) continue;
      try { out.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * Parse Claude Code transcript lines into ordered events.
 * Event shape: { idx, kind: 'text'|'tool', role?, name?, text? }.
 */
export function parseClaudeCode(lines) {
  const events = [];
  lines.forEach((line, idx) => {
    if (!line || !line.trim()) return;
    let e; try { e = JSON.parse(line); } catch { return; }
    const content = e?.message?.content;
    const role = e?.message?.role;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') events.push({ idx, kind: 'text', role, text: c.text });
      else if (c?.type === 'tool_use') events.push({ idx, kind: 'tool', role, name: c.name, text: stringifyInput(c.input) });
    }
  });
  return events;
}

/**
 * Parse Codex rollout lines into ordered events. Surfaces response_item message text,
 * function_call + custom_tool_call as `tool` events (name + input/arguments text), and
 * event_msg agent/user messages. *_output return values + encrypted reasoning skipped.
 */
export function parseCodex(lines) {
  const events = [];
  lines.forEach((line, idx) => {
    if (!line || !line.trim()) return;
    let e; try { e = JSON.parse(line); } catch { return; }
    const p = e?.payload;
    if (!p) return;
    if (e.type === 'response_item' && p.type === 'message' && Array.isArray(p.content)) {
      const text = p.content.filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n');
      if (text) events.push({ idx, kind: 'text', role: p.role, text });
    } else if (e.type === 'response_item' && p.type === 'function_call') {
      // exec_command / shell etc. arguments is a JSON string carrying cmd + paths.
      events.push({ idx, kind: 'tool', role: 'assistant', name: p.name, text: stringifyInput(p.arguments) });
    } else if (e.type === 'response_item' && p.type === 'custom_tool_call') {
      // apply_patch etc. input is a string carrying the patch / file paths.
      events.push({ idx, kind: 'tool', role: 'assistant', name: p.name, text: stringifyInput(p.input) });
    } else if (e.type === 'event_msg' && (p.type === 'agent_message' || p.type === 'user_message')) {
      // message/text are usually strings, but a structured-content payload carries an
      // array of {text} blocks — pull text out of those too rather than dropping the turn.
      const fromArray = (v) => Array.isArray(v) ? v.filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n') : '';
      const text = typeof p.message === 'string' ? p.message
        : typeof p.text === 'string' ? p.text
        : fromArray(p.message) || fromArray(p.content);
      if (text) events.push({ idx, kind: 'text', role: p.type === 'user_message' ? 'user' : 'assistant', text });
    }
    // reasoning (encrypted) + *_output (return values, not access-intent) not surfaced.
  });
  return events;
}

/** Dispatch parse by harness. Unknown → []. */
export function parseTranscript(content, harness) {
  const lines = String(content || '').split('\n');
  if (harness === 'claude-code') return parseClaudeCode(lines);
  if (harness === 'codex') return parseCodex(lines);
  return [];
}

/**
 * Read + normalize this project's transcript for a harness.
 * Returns { harness, path, available, reason, events, meta }. Fail-open: never throws on
 * a missing/unreadable transcript — returns available:false with empty events and a
 * reason naming why, so a consumer can tell UNKNOWN apart from "nothing happened".
 */
export function readTranscript({ harness, cwd = process.cwd(), home = homedir(), override = null, sessionId = null, env = process.env } = {}) {
  const meta = {
    schema_version: SCHEMA_VERSION,
    harness,
    supported: SUPPORTED_HARNESSES.has(harness),
    codex_tool_extraction: harness === 'codex' ? 'implemented' : 'n/a',
    transcript_resolution: null,
    transcript_unavailable_reason: null,
  };
  const unavailable = (path, reason) => {
    meta.transcript_unavailable_reason = reason;
    return { harness, path, available: false, reason, events: [], meta };
  };
  if (!SUPPORTED_HARNESSES.has(harness)) return unavailable(null, 'unsupported-harness');
  const { path, resolution, reason } = resolveTranscript(harness, { cwd, home, override, sessionId, env });
  meta.transcript_resolution = resolution;
  if (!path || !existsSync(path)) return unavailable(path, reason || 'no-project-transcript');
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return unavailable(path, 'unreadable'); }
  return { harness, path, available: true, reason: null, events: parseTranscript(content, harness), meta };
}

function stringifyInput(input) {
  if (input == null) return '';
  try { return typeof input === 'string' ? input : JSON.stringify(input); } catch { return ''; }
}
