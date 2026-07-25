/**
 * read-transcript.mjs — v2.9 `read-transcript` adapter verb (deterministic core).
 *
 * The redesign audit (2026-05-29) named transcript introspection the one genuinely
 * new adapter capability: portable across harnesses but with different on-disk paths
 * and JSONL schemas. Per the central principle, native specifics live in the adapter
 * layer, not core prose — so this script resolves a transcript path per harness and
 * normalizes the lines into one ordered event shape that consumers (memory-accessed,
 * retrieval-skip detection, anti-anchoring ordering proofs) can read uniformly.
 * Transcript selection is session-id-exact on claude-code (MET-008); mtime-latest is
 * a documented fallback recorded in meta.transcript_resolution.
 *
 * Schemas verified on disk 2026-05-29 (evidence, not assumption):
 *   - claude-code: ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session>.jsonl
 *       message lines carry `message.content[]` with {type:'text'|'tool_use', ...}.
 *   - codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *       lines are {timestamp, type, payload}; type 'response_item' + payload.type
 *       'message' carry {role, content:[{type, text}]}; payload.type 'reasoning' is
 *       encrypted (skipped); 'event_msg' carries agent_message/user_message/etc.
 *
 * Codex tool/shell extraction (v2.9 Slice F — IMPLEMENTED): function_call (exec_command
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapProjectPathToSlug } from './project-slug.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const SUPPORTED_HARNESSES = new Set(['claude-code', 'codex']);

/**
 * Resolve the transcript for a harness, with the resolution method made explicit.
 *
 * MET-008: mtime-latest selection alone is a race — if a NEW session starts before
 * the /finalize analyzers run, every derived metric reads the wrong session. For
 * claude-code the transcript filename IS the session id, so exact-match resolution
 * (explicit sessionId arg, else CLAUDE_CODE_SESSION_ID) is authoritative; mtime is
 * the DOCUMENTED FALLBACK only (no session id in scope, or the file isn't there).
 * Codex rollout filenames don't carry CODEX_THREAD_ID, so codex stays mtime-based —
 * consumers can see that in meta.transcript_resolution and weigh trust accordingly.
 *
 * Returns { path, resolution } — resolution ∈ 'override' | 'session-id'
 * | 'mtime-fallback' | null.
 */
export function resolveTranscript(harness, { cwd = process.cwd(), home = homedir(), override = null, sessionId = null, env = process.env } = {}) {
  if (override) return existsSync(override) ? { path: override, resolution: 'override' } : { path: null, resolution: null };
  if (harness === 'claude-code') {
    const dir = join(home, '.claude', 'projects', mapProjectPathToSlug(String(cwd)));
    const sid = sessionId || env.CLAUDE_CODE_SESSION_ID || null;
    if (sid) {
      const exact = join(dir, `${sid}.jsonl`);
      if (existsSync(exact)) return { path: exact, resolution: 'session-id' };
    }
    const latest = latestFile(dir, (f) => f.endsWith('.jsonl'));
    return { path: latest, resolution: latest ? 'mtime-fallback' : null };
  }
  if (harness === 'codex') {
    // rollout-*.jsonl nested under YYYY/MM/DD — walk the sessions tree.
    const latest = latestFileRecursive(join(home, '.codex', 'sessions'), (f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    return { path: latest, resolution: latest ? 'mtime-fallback' : null };
  }
  // unknown harness — return null (resolver drop).
  return { path: null, resolution: null };
}

/** Back-compat path-only resolver. Prefer resolveTranscript for new callers. */
export function resolveTranscriptPath(harness, opts = {}) {
  return resolveTranscript(harness, opts).path;
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

function latestFileRecursive(root, pred) {
  if (!existsSync(root)) return null;
  let latest = null, latestM = -1;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!pred(e.name)) continue;
      try { const m = statSync(p).mtimeMs; if (m > latestM) { latestM = m; latest = p; } } catch { /* skip */ }
    }
  }
  return latest;
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
 * Read + normalize the latest transcript for a harness.
 * Returns { harness, path, available, events, meta }. Fail-open: never throws on a
 * missing/unreadable transcript — returns available:false with empty events.
 */
export function readTranscript({ harness, cwd = process.cwd(), home = homedir(), override = null, sessionId = null, env = process.env } = {}) {
  const meta = {
    schema_version: SCHEMA_VERSION,
    harness,
    supported: SUPPORTED_HARNESSES.has(harness),
    codex_tool_extraction: harness === 'codex' ? 'implemented' : 'n/a',
    transcript_resolution: null,
  };
  if (!SUPPORTED_HARNESSES.has(harness)) return { harness, path: null, available: false, events: [], meta };
  const { path, resolution } = resolveTranscript(harness, { cwd, home, override, sessionId, env });
  meta.transcript_resolution = resolution;
  if (!path || !existsSync(path)) return { harness, path, available: false, events: [], meta };
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return { harness, path, available: false, events: [], meta }; }
  return { harness, path, available: true, events: parseTranscript(content, harness), meta };
}

function stringifyInput(input) {
  if (input == null) return '';
  try { return typeof input === 'string' ? input : JSON.stringify(input); } catch { return ''; }
}
