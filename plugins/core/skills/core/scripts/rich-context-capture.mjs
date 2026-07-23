#!/usr/bin/env node
/**
 * rich-context-capture.mjs — the OPT-IN, off-by-default rich-context stream.
 *
 * Why this exists (Hale's minimum-complete-metrics-evidence-lifecycle contract,
 * 2026-07-22, implementation-order item 4): when a retrieval outcome is bad — a
 * miss, a no-hit, a corrective retry — the closed-schema telemetry
 * (`retrieval-log.jsonl` / `outcome-log.jsonl`) records THAT it happened but not
 * WHY. It carries no query text, no delivered context-pack, none of the
 * surrounding turn. That is exactly what a developer needs to debug a failure.
 * This stream captures that context LOCALLY so it can be inspected by a human (or
 * the agent at the time) — never a model inference layer over it (a local-LLM
 * "judgment layer" was explicitly DECLINED per DC-114, no local models).
 *
 * TWO PHYSICAL STREAMS, one rule (product-contract item 2): the closed-schema
 * metrics stream and this rich-context stream are separate files, and the
 * package exporter (`metrics-package.mjs`) has NO code path that reads this
 * directory. The isolation is structural (the exporter reads a fixed set of named
 * sources; `_metrics/rich-context/` is not among them) and permanently guarded by
 * a canary tripwire test.
 *
 * SENSITIVITY: this is the materially more sensitive stream — it saves the user's
 * literal query text and the literal delivered context. So, unlike the aggregate
 * metrics stream (default-ON per DC-107), this one is:
 *   - OFF by default. Active ONLY when the project's `workspace.json` carries
 *     `"rich_context_capture": true` (per-project, explicit) — mirroring how
 *     `metrics_enabled` is read, but with the opposite default.
 *   - independently disableable (its own flag; disabling it never touches metrics,
 *     enabling metrics never enables it),
 *   - retained 30 days by default (retention runs through maintenance-run.mjs),
 *   - purgeable on an explicit user ask (`--purge`).
 *
 * SHIPPED-DEFAULT SAFETY (risk-24): the safe posture is the shipped default. A
 * stranger installing core-plugin gets this stream OFF; enabling it is each user's
 * own explicit choice on their own project. No personal authorization is ever
 * baked into the shipped code path.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * Storage: `<metrics-storage-base>/rich-context/<YYYY-MM-DD>.jsonl`, where the base
 * is whatever `metrics-init.mjs` pinned (project-local `_metrics/` on Mac/Linux;
 * the AppData redirect on Windows+OneDrive). It lives inside the same
 * already-redirected `_metrics` area as the rest of the metrics substrate.
 *
 * Concurrency: appends route through `withFileLock` (the append-interleaving
 * discipline accepted from Antigravity, refined by Hale — not a PIPE_BUF claim,
 * but portable crash/concurrency safety for large JSONL rows from concurrent
 * writers).
 *
 * Failure-mode discipline: never throws on the capture path. A capture that can't
 * be written is reported and dropped — it must never block or crash the turn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';
import { resolveStoragePath, resolveWorkspaceId } from './log-event.mjs';

// Bump ONLY when the row contract changes in a way that would make an older
// reader misread rows (same discipline as record-retrieval-event.mjs).
export const RICH_CONTEXT_SCHEMA_VERSION = '1.0.0';

// Hale's number. The window is measured in whole days against the row date.
export const RICH_CONTEXT_DEFAULT_RETENTION_DAYS = 30;

// Byte cap for each captured free-text field (query and delivered-pack head).
// Enough to debug from; bounded so an adversarial or just-huge value can't
// balloon the file. Applied on a real UTF-8 byte offset (never String.slice,
// which counts UTF-16 code units — the K-series byte-cap lesson).
export const RICH_CONTEXT_MAX_FIELD_BYTES = 4096;

// The directory name is load-bearing: every deletion path asserts against it so
// no purge/retention op can ever target anything but this stream's own files.
export const RICH_CONTEXT_DIRNAME = 'rich-context';

// Outcome verdicts worth enriching. 'noisy' is included for completeness (a
// later human/agent judgment can record it) even though the synchronous
// in-hook seam can only observe 'no-hit'/'miss'/'corrective-retry' directly.
export const RICH_CONTEXT_VERDICTS = new Set(['miss', 'no-hit', 'noisy', 'corrective-retry', 'unknown']);

const DATE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
// C0 controls except \n/\t plus DEL — inert in JSON on disk, but downstream
// renderers aren't guaranteed to handle them; strip them at capture time.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Is the opt-in rich-context stream active for this project?
 *
 * OFF by default. Precedence (first match wins):
 *   1. env `CORE_RICH_CONTEXT_CAPTURE` false (0/false/no/off) → OFF (hard opt-out).
 *   2. env `CORE_RICH_CONTEXT_CAPTURE` true  (1/true/yes/on)  → ON  (test/force).
 *   3. `<project>/workspace.json` `"rich_context_capture": true` → ON (the real switch).
 *   4. default → OFF.
 *
 * Contrast metricsEnabled(), which defaults ON — this stream is more sensitive,
 * so its default is the opposite.
 */
export function richContextCaptureEnabled({ project, env = process.env } = {}) {
  const flag = (env.CORE_RICH_CONTEXT_CAPTURE || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false;
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    try {
      const p = JSON.parse(readFileSync(join(project, 'workspace.json'), 'utf8'));
      if (p && p.rich_context_capture === true) return true;
    } catch { /* fall through to default-off */ }
  }
  return false; // default-OFF — the sensitive stream is opt-in only
}

/** Absolute dir for this project's rich-context stream. */
export function richContextDir(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), RICH_CONTEXT_DIRNAME);
}

/** Stable lock path for the stream — one writer at a time across processes. */
export function richContextLockPath(projectDir, { workspaceId } = {}) {
  return join(richContextDir(projectDir, { workspaceId }), '.rich-context.lock');
}

/**
 * The trigger predicate: is THIS retrieval a bad outcome worth enriching?
 * Only the synchronously-observable bad signals count here — a zero-hit result,
 * or a corrective-retry shape detected in-hook. ('noisy' needs a later
 * judgment the retrieval hook can't make, so it is never decided here.)
 */
export function shouldEnrichRichContext({ zeroHit = false, retryShaped = false } = {}) {
  return Boolean(zeroHit || retryShaped);
}

/** Byte-safe head of a string: never splits a multi-byte UTF-8 sequence. */
export function byteCapHead(str, maxBytes = RICH_CONTEXT_MAX_FIELD_BYTES) {
  const clean = String(str ?? '').replace(CONTROL_CHARS_RE, '');
  const buf = Buffer.from(clean, 'utf8');
  if (buf.length <= maxBytes) return { head: clean, fullBytes: buf.length, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--; // back off a continuation byte
  return { head: buf.subarray(0, end).toString('utf8'), fullBytes: buf.length, truncated: true };
}

function strOrNull(value, maxLen = 200) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(CONTROL_CHARS_RE, '').slice(0, maxLen);
}

/**
 * Normalize + byte-cap one row. Query text is REQUIRED (a rich-context row with
 * no query is not worth writing); everything else is best-effort identity so a
 * capture with partial context still records what it can.
 */
export function normalizeRichContextRow(input) {
  if (!input || typeof input !== 'object') throw new Error('rich-context row must be an object');
  const query = byteCapHead(input.query_text, RICH_CONTEXT_MAX_FIELD_BYTES);
  if (!query.head.trim()) throw new Error('rich-context row: query_text must be a non-empty string');
  const pack = byteCapHead(input.context_pack_head ?? input.context_pack ?? '', RICH_CONTEXT_MAX_FIELD_BYTES);
  const verdict = RICH_CONTEXT_VERDICTS.has(input.verdict) ? input.verdict : 'unknown';
  const escalationPath = Array.isArray(input.escalation_path)
    ? input.escalation_path.filter((t) => Number.isInteger(t) && t >= 1 && t <= 3)
    : [];
  return {
    kind: 'rich-context',
    schema_version: RICH_CONTEXT_SCHEMA_VERSION,
    retrieval_id: strOrNull(input.retrieval_id, 200),
    session_id: strOrNull(input.session_id, 80),
    turn_id: strOrNull(input.turn_id, 80),
    harness: strOrNull(input.harness, 40),
    verdict,
    tier_reached: Number.isInteger(input.tier_reached) ? input.tier_reached : null,
    escalation_path: escalationPath,
    producer_version: strOrNull(input.producer_version, 24) || 'unknown',
    producer_sha: strOrNull(input.producer_sha, 44) || 'unknown',
    query_text: query.head,
    query_bytes: query.fullBytes,
    query_truncated: query.truncated,
    context_pack_head: pack.head,
    context_pack_bytes: pack.fullBytes,
    context_pack_truncated: pack.truncated,
  };
}

/** UTC date (YYYY-MM-DD) for row bucketing. */
function todayUTC(now) {
  return (now ? new Date(now) : new Date()).toISOString().slice(0, 10);
}

/**
 * Capture one rich-context row. Self-guards on the opt-in flag (defense in
 * depth — the caller also checks it) and never throws.
 *
 * @returns {{ captured: boolean, reason?: string, path?: string, row?: object }}
 */
export function captureRichContext(projectDir, input, { workspaceId, now, env = process.env, force = false } = {}) {
  try {
    if (!existsSync(projectDir)) return { captured: false, reason: 'project-dir-missing' };
    if (!force && !richContextCaptureEnabled({ project: projectDir, env })) {
      return { captured: false, reason: 'capture-disabled' };
    }
    const wsId = workspaceId || resolveWorkspaceId(projectDir);
    let row;
    try { row = normalizeRichContextRow(input); }
    catch (e) { return { captured: false, reason: `invalid-row: ${e.message}` }; }
    const record = { ts: now || new Date().toISOString(), ...row };
    const dir = richContextDir(projectDir, { workspaceId: wsId });
    const file = join(dir, `${todayUTC(now)}.jsonl`);
    mkdirSync(dir, { recursive: true });
    withFileLock(richContextLockPath(projectDir, { workspaceId: wsId }), () => {
      // Import fs lazily-free: appendFileSync via a fresh require would break the
      // single-writer discipline; use the already-imported primitives.
      appendLine(file, JSON.stringify(record));
    });
    return { captured: true, path: file, row: record };
  } catch (e) {
    return { captured: false, reason: `capture-failed: ${String(e && e.message).slice(0, 120)}` };
  }
}

// Small append helper kept separate so the lock body stays a one-liner.
function appendLine(file, line) { appendFileSync(file, line + '\n'); }

// ---------- read-side helpers (for /metrics visible-active-state) ----------

/** List `<date>.jsonl` files in the stream dir, newest date last. */
export function listRichContextFiles(projectDir, { workspaceId } = {}) {
  const dir = richContextDir(projectDir, { workspaceId });
  if (!existsSync(dir)) return [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => DATE_FILE_RE.test(n))
    .sort()
    .map((n) => ({ date: n.slice(0, 10), file: join(dir, n) }));
}

/**
 * Cheap census for the /metrics mechanics line: whether the stream is on, and
 * how much is captured. Row count is a line count (no per-row parse).
 */
export function richContextStats(projectDir, { workspaceId, env = process.env } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const enabled = richContextCaptureEnabled({ project: projectDir, env });
  const files = listRichContextFiles(projectDir, { workspaceId: wsId });
  let rows = 0;
  for (const { file } of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) rows++;
    } catch { /* unreadable file contributes no rows */ }
  }
  return { enabled, days: files.length, rows, dir: richContextDir(projectDir, { workspaceId: wsId }) };
}

// ---------- deletion ops (retention + purge) ----------
//
// BOUNDARY (load-bearing): every deletion here is scoped to CORE's OWN capture
// files under `<storage-base>/rich-context/`. It NEVER touches user memory units,
// PROJECT.md, session logs, or anything outside this one directory. The path
// assertions below refuse any target that isn't a `<YYYY-MM-DD>.jsonl` file
// directly inside a directory named exactly `rich-context`.

function assertInsideRichContext(targetFile, dir) {
  if (basename(dir) !== RICH_CONTEXT_DIRNAME) {
    throw new Error(`refusing deletion: stream dir is not named '${RICH_CONTEXT_DIRNAME}' (${dir})`);
  }
  if (dirname(targetFile) !== dir) {
    throw new Error(`refusing deletion: target escapes the rich-context dir (${targetFile})`);
  }
  if (!DATE_FILE_RE.test(basename(targetFile))) {
    throw new Error(`refusing deletion: target is not a <date>.jsonl row file (${targetFile})`);
  }
}

/**
 * Retention pass. Deletes row files whose date is older than `windowDays`.
 * Dry-run (apply:false) reports candidates and deletes nothing. Apply deletes,
 * then verifies each deletion.
 *
 * @returns {{ ran, reason?, windowDays, cutoff, candidates:string[], deleted:string[], kept:string[], verified:boolean }}
 */
export function runRichContextRetention(projectDir, {
  windowDays = RICH_CONTEXT_DEFAULT_RETENTION_DAYS,
  apply = true,
  now = new Date().toISOString(),
  workspaceId,
  env = process.env,
} = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const dir = richContextDir(projectDir, { workspaceId: wsId });
  const base = { windowDays, candidates: [], deleted: [], kept: [], verified: true };
  if (!existsSync(dir)) return { ran: false, reason: 'no-rich-context-dir', cutoff: null, ...base };

  const cutoffMs = new Date(now).getTime() - windowDays * 86400000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  const files = listRichContextFiles(projectDir, { workspaceId: wsId });
  for (const { date, file } of files) {
    // Interpret the row date as end-of-day UTC so a file dated exactly on the
    // window boundary is kept, not deleted (only strictly-older files go).
    const fileMs = new Date(`${date}T23:59:59Z`).getTime();
    if (fileMs >= cutoffMs) { base.kept.push(file); continue; }
    base.candidates.push(file);
  }

  if (!apply) return { ran: true, cutoff, ...base };

  for (const file of base.candidates) {
    try {
      assertInsideRichContext(file, dir); // refuse anything outside the stream dir
      rmSync(file, { force: true });
      if (existsSync(file)) { base.verified = false; }
      else base.deleted.push(file);
    } catch (e) {
      base.verified = false;
      base.kept.push(`${file} (retention-error: ${String(e && e.message).slice(0, 80)})`);
    }
  }
  return { ran: true, cutoff, ...base };
}

/**
 * Purge the ENTIRE rich-context stream directory. The confirmation contract is
 * prose-level (the SKILL/protocol require an explicit user ask); this function
 * does the mechanical part only, behind the same directory-name assertion.
 *
 * @returns {{ purged: boolean, reason?: string, dir: string, existed: boolean }}
 */
export function purgeRichContext(projectDir, { apply = true, workspaceId, env = process.env } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const dir = richContextDir(projectDir, { workspaceId: wsId });
  // Hard boundary: only ever remove a directory named exactly 'rich-context'
  // that sits directly under the resolved metrics storage base. Anything else
  // — a tampered pin, a symlink games, a misresolved base — is refused.
  const base = resolveStoragePath(projectDir, { workspaceId: wsId });
  if (basename(dir) !== RICH_CONTEXT_DIRNAME || dirname(dir) !== base) {
    return { purged: false, reason: `refusing purge: '${dir}' is not <storage-base>/${RICH_CONTEXT_DIRNAME}`, dir, existed: existsSync(dir) };
  }
  const existed = existsSync(dir);
  if (!existed) return { purged: true, dir, existed: false };
  if (!apply) return { purged: false, reason: 'dry-run', dir, existed: true };
  try {
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(dir)) return { purged: false, reason: 'delete-unverified', dir, existed: true };
    return { purged: true, dir, existed: true };
  } catch (e) {
    return { purged: false, reason: `purge-failed: ${String(e && e.message).slice(0, 120)}`, dir, existed: true };
  }
}

// ---------- CLI ----------
// Capture is normally called in-process from retrieve-context-hook.mjs; the CLI
// exists for status inspection and the operator deletion ops.

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags.set(key, true);
      else { flags.set(key, next); i++; }
    } else positionals.push(a);
  }
  return { flags, positionals };
}

export function main(argv) {
  const { flags, positionals } = parseArgs(argv);
  const projectDir = positionals[0];
  if (!projectDir) {
    process.stderr.write('usage: rich-context-capture.mjs <project-dir> [--status | --retention [--window N] [--apply] | --purge [--apply]]\n');
    return 1;
  }
  if (flags.get('purge')) {
    const res = purgeRichContext(projectDir, { apply: Boolean(flags.get('apply')) });
    process.stdout.write(JSON.stringify(res) + '\n');
    return res.purged || res.reason === 'dry-run' ? 0 : 2;
  }
  if (flags.get('retention')) {
    const windowDays = flags.get('window') ? Number(flags.get('window')) : RICH_CONTEXT_DEFAULT_RETENTION_DAYS;
    const res = runRichContextRetention(projectDir, { windowDays, apply: Boolean(flags.get('apply')) });
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  // default: status
  const stats = richContextStats(projectDir);
  process.stdout.write(JSON.stringify(stats) + '\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
