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
 * SENSITIVITY: this is the materially more sensitive stream — it saves a bounded
 * head (4 KiB) of the user's literal query text and of the literal delivered
 * context, on a synchronous no-hit. So, unlike the aggregate metrics stream
 * (default-ON per DC-107), this one is:
 *   - OFF by default. Active ONLY when the MACHINE-LOCAL, PER-USER workspace meta
 *     (`~/.core/workspaces/<id>/workspace.json`) carries `"rich_context_capture":
 *     true`. It is deliberately NOT read from the project-root `workspace.json`
 *     pointer (Hale ea140b0 item 2): that file travels with a copied or shared
 *     project, so a project-root flag would let one user's sensitive-capture
 *     choice ride along into a teammate's or a copied workspace. The switch lives
 *     with the user's own machine, never with the shared project tree.
 *   - independently disableable (its own flag; disabling it never touches metrics,
 *     enabling metrics never enables it). Note the hook only WRITES when aggregate
 *     metrics are also on, so the /metrics render reports EFFECTIVE state, not just
 *     the configured flag (item 5).
 *   - retained 30 days by default (retention runs through maintenance-run.mjs),
 *   - purgeable on an explicit user ask (`--purge`).
 *
 * SHIPPED-DEFAULT SAFETY (risk-24): the safe posture is the shipped default. A
 * stranger installing core-plugin gets this stream OFF; enabling it is each user's
 * own explicit choice, recorded only in that user's own machine-local workspace
 * meta. No personal authorization is ever baked into the shipped code path, and no
 * project-root flag can activate it.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * Storage: `<metrics-storage-base>/rich-context/<YYYY-MM-DD>.jsonl`, where the base
 * is whatever `metrics-init.mjs` pinned (project-local `_metrics/` on Mac/Linux;
 * the AppData redirect on Windows+OneDrive). It lives inside the same
 * already-redirected `_metrics` area as the rest of the metrics substrate.
 *
 * Concurrency: appends, retention deletion, and purge ALL route through ONE
 * exclusion lock (Hale ea140b0 item 4) whose path is a STABLE SIBLING OUTSIDE the
 * purged directory (`<storage-base>/.rich-context.lock`, never inside
 * `<storage-base>/rich-context/`). A purge removes the whole stream directory, so
 * a lock kept inside it could be unlinked out from under a mid-flight writer; a
 * sibling lock cannot be. The shared lock serializes the three ops against each
 * other, so a purge or retention delete can never race an in-progress append
 * (no lost or torn rows, no delete-while-appending). The lock is portable
 * crash/concurrency safety for large JSONL rows from concurrent writers (the
 * append-interleaving discipline accepted from Antigravity, refined by Hale — not
 * a PIPE_BUF claim).
 *
 * Failure-mode discipline: never throws on the capture path. A capture that can't
 * be written is reported and dropped — it must never block or crash the turn.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';
import { resolveStoragePath, resolveWorkspaceId, metricsEnabled } from './log-event.mjs';

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

// Owner-only filesystem modes for the sensitive surface (Hale ea140b0 item 3).
// This stream holds literal query text and delivered context, so the directory
// and its row files are locked to the owning user: dir 0700, files 0600. These
// are asserted on create AND re-asserted on every append. chmod is best-effort:
// Windows only honors the read-only bit and some network/synced filesystems
// reject chmod outright, so a failed hardening never fails the capture — but on
// every POSIX filesystem that supports it, the modes are enforced.
export const RICH_CONTEXT_DIR_MODE = 0o700;
export const RICH_CONTEXT_FILE_MODE = 0o600;

// Closed vocabulary for the rich-capture status surfaced on the retrieval hook's
// terminal operational receipt (Hale ea140b0 item 6). A status code — never raw
// query/context content — so a capture outcome (including a silent-until-now
// failure) is observable on the existing receipt without leaking the sensitive
// payload the stream exists to hold.
export const RICH_CAPTURE_STATUS = new Set([
  'captured', 'disabled', 'project-dir-missing', 'invalid-row', 'capture-failed', 'error',
]);

// Outcome verdicts a row may carry. Only 'no-hit' is written by the synchronous
// in-hook capture seam (Hale ea140b0 item 1): a corrective retry is evidence
// about the PRIOR retrieval's outcome, and this seam holds the CURRENT retrieval's
// id/query/pack, so labeling the current retrieval 'corrective-retry' would bind
// the evidence to the wrong subject. The retry trigger is therefore dropped from
// in-hook capture; 'miss'/'noisy'/'corrective-retry' remain valid verdicts ONLY
// for a later human/agent judgment recorded out of band, never the live hook.
export const RICH_CONTEXT_VERDICTS = new Set(['miss', 'no-hit', 'noisy', 'corrective-retry', 'unknown']);

const DATE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
// C0 controls except \n/\t plus DEL — inert in JSON on disk, but downstream
// renderers aren't guaranteed to handle them; strip them at capture time.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Machine-local, per-user workspace meta path for a project (Hale ea140b0 item 2).
 * This is the MANIFEST file — `~/.core/workspaces/<id>/workspace.json` — the same
 * per-user operational-meta surface that metrics-disclosure.mjs reads/writes, NOT
 * the project-root `workspace.json` pointer (which travels with a copied/shared
 * project). homedir() honors HOME/USERPROFILE, so a test can redirect it.
 */
export function userWorkspaceMetaPath(projectDir, { workspaceId } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  return join(homedir(), '.core', 'workspaces', wsId, 'workspace.json');
}

/**
 * Is the opt-in rich-context stream active for this project?
 *
 * OFF by default. Precedence (first match wins):
 *   1. env `CORE_RICH_CONTEXT_CAPTURE` false (0/false/no/off) → OFF (hard opt-out).
 *   2. env `CORE_RICH_CONTEXT_CAPTURE` true  (1/true/yes/on)  → ON  (test/force).
 *   3. MACHINE-LOCAL per-user workspace meta (`~/.core/workspaces/<id>/workspace.json`)
 *      `"rich_context_capture": true` → ON (the real switch).
 *   4. default → OFF.
 *
 * The switch is read ONLY from the machine-local per-user manifest, NEVER from the
 * project-root `workspace.json` pointer: that pointer travels with a copied or
 * shared project, so honoring a flag there would let one user's sensitive-capture
 * choice ride into a teammate's copy. A project-root flag is therefore ignored.
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
      const m = JSON.parse(readFileSync(userWorkspaceMetaPath(project), 'utf8'));
      if (m && m.rich_context_capture === true) return true;
    } catch { /* no per-user manifest / not set → fall through to default-off */ }
  }
  return false; // default-OFF — the sensitive stream is opt-in only, per user
}

/** Absolute dir for this project's rich-context stream. */
export function richContextDir(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), RICH_CONTEXT_DIRNAME);
}

/**
 * The ONE exclusion lock shared by append, retention deletion, and purge (Hale
 * ea140b0 item 4). It lives as a STABLE SIBLING of the stream dir — directly
 * under the storage base, OUTSIDE `rich-context/` — so a purge that removes the
 * whole `rich-context/` directory can never unlink the lock out from under a
 * mid-append writer. All three ops acquire this same path, serializing them.
 */
export function richContextLockPath(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), '.rich-context.lock');
}

/** chmod best-effort — never fails the caller (Windows/synced-FS honor only some
 * bits). Used to assert owner-only modes on create and re-assert on every append. */
function hardenPath(target, mode) {
  try { chmodSync(target, mode); } catch { /* best-effort: not every FS supports chmod */ }
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
    withFileLock(richContextLockPath(projectDir, { workspaceId: wsId }), () => {
      // mkdir + append + hardening all happen INSIDE the shared lock (item 4): a
      // concurrent purge that removes the dir can never race between our mkdir and
      // our append, and the owner-only modes (item 3) are asserted on create and
      // RE-asserted on every append, so a file that predates this hardening — or
      // one a purge/retention cycle recreated — is corrected every time we write.
      mkdirSync(dir, { recursive: true, mode: RICH_CONTEXT_DIR_MODE });
      hardenPath(dir, RICH_CONTEXT_DIR_MODE);
      appendLine(file, JSON.stringify(record));
      hardenPath(file, RICH_CONTEXT_FILE_MODE);
    });
    return { captured: true, path: file, row: record };
  } catch (e) {
    return { captured: false, reason: `capture-failed: ${String(e && e.message).slice(0, 120)}` };
  }
}

// Small append helper kept separate so the lock body stays a one-liner.
function appendLine(file, line) { appendFileSync(file, line + '\n'); }

/**
 * Map a captureRichContext() result to a CLOSED status code for the retrieval
 * hook's terminal operational receipt (Hale ea140b0 item 6). Returns a code from
 * RICH_CAPTURE_STATUS only — the free-text `reason` (which can embed an error
 * message) is reduced to its leading token, so a capture outcome — including a
 * failure that used to be swallowed silently — is observable WITHOUT echoing any
 * raw query or context content onto the receipt.
 */
export function richCaptureStatusCode(result) {
  if (!result || typeof result !== 'object') return 'error';
  if (result.captured) return 'captured';
  // Reduce the free-text reason to a leading token, then fold onto the closed set.
  const head = String(result.reason || 'error').split(/[:\s]/)[0];
  if (head === 'capture-disabled') return 'disabled';
  if (RICH_CAPTURE_STATUS.has(head)) return head;
  return 'capture-failed';
}

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
 *
 * EFFECTIVE STATE (Hale ea140b0 item 5): the retrieve-context hook only WRITES
 * rich rows inside the `metricsEnabled()` branch — the sensitive stream is nested
 * under the aggregate-metrics master switch. So the configured flag alone can be
 * ON while nothing can ever be captured. This reports both the configured flag
 * (`enabled`) and the EFFECTIVE state (`effective` = flag AND aggregate metrics
 * on), plus an honest `inactiveReason` when configured-on-but-inactive, so the
 * /metrics render can say exactly that instead of a bare "ON".
 */
export function richContextStats(projectDir, { workspaceId, env = process.env } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const enabled = richContextCaptureEnabled({ project: projectDir, env });
  const metricsOn = metricsEnabled({ project: projectDir, env });
  const effective = enabled && metricsOn;
  const inactiveReason = enabled && !metricsOn ? 'aggregate metrics disabled' : null;
  const files = listRichContextFiles(projectDir, { workspaceId: wsId });
  let rows = 0;
  for (const { file } of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) rows++;
    } catch { /* unreadable file contributes no rows */ }
  }
  return { enabled, effective, inactiveReason, days: files.length, rows, dir: richContextDir(projectDir, { workspaceId: wsId }) };
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

  // Delete under the SHARED lock (item 4): a concurrent append can never be
  // mid-write on a file this loop unlinks, and a concurrent purge can't remove
  // the dir out from under us. Retention only targets files strictly older than
  // the cutoff, and a writer only ever touches TODAY's file — but the shared lock
  // makes the no-delete-while-appending guarantee hold regardless of policy.
  try {
    withFileLock(richContextLockPath(projectDir, { workspaceId: wsId }), () => {
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
    });
  } catch (e) {
    // Couldn't acquire the shared lock within budget (contended). Honest, not
    // silent: nothing was deleted, and the pass reports itself unverified.
    base.verified = false;
    base.kept.push(`(retention-lock-unavailable: ${String(e && e.code || e && e.message).slice(0, 40)})`);
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
    // Purge under the SHARED lock (item 4). The lock lives OUTSIDE `dir` (a
    // sibling under the storage base), so removing `dir` recursively never
    // unlinks the lock itself; and a concurrent writer either finished before
    // us (its row is in a file we then remove — an expected purge) or waits
    // behind us and recreates the dir cleanly afterward — never a torn write.
    withFileLock(richContextLockPath(projectDir, { workspaceId: wsId }), () => {
      rmSync(dir, { recursive: true, force: true });
    });
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
