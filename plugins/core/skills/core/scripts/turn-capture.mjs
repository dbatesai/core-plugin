#!/usr/bin/env node
/**
 * turn-capture.mjs — the every-turn evidence layer (evidence chain, Link 1).
 *
 * Why this exists (evidence-chain spec): the closed-schema telemetry
 * (`retrieval-log.jsonl`) records THAT retrieval happened — ≤8 keyword tokens,
 * delivered unit ids, counts — but nothing recorded today lets a later reader
 * judge whether the loaded memories were RIGHT for the moment. This stream
 * captures the full turn evidence LOCALLY: the actual prompt, the delivered
 * pack text per unit, the top rejected candidates with scores, and a store
 * signature so the hindsight judge can flag store drift. The judge
 * (hindsight-judge.mjs) reads it later; the exporter NEVER does.
 *
 * It supersedes the rich-context stream (fired only on zero-hits — and a
 * zero-hit has no delivered context by definition) and the hidden
 * CORE_RETRIEVAL_TRACE env stream (content in the repo tree, no reader).
 *
 * DEFAULT-ON with opt-outs (the product owner's explicit ruling over the opt-in
 * recommendation, recorded in the spec):
 *   1. `CORE_METRICS_ENABLED` off → OFF (master kill switch; capture nests
 *      inside the metrics gate).
 *   2. `CORE_TURN_CAPTURE` env false → OFF (its own hard switch).
 *   3. project-root `workspace.json` `"turn_capture": false` → OFF. Unlike
 *      rich-context's opt-IN (machine-local only, so a sensitive enable could
 *      never travel with a copied project), an opt-OUT travelling with a copied
 *      project is privacy-safe — the flag lives with the project on purpose.
 *   4. default → ON. An off-by-default flight recorder records nothing.
 *
 * PROTECTIONS (inherited from the rich-context design wholesale):
 *   - storage under `resolveStoragePath()` (`metrics-init` pin file; honors the
 *     Windows+OneDrive AppData redirect), stream dir `<base>/turn-capture/`;
 *   - dir 0700 / files 0600, asserted on create and re-asserted per append;
 *   - one exclusion lock shared by append/retention/purge, a STABLE SIBLING
 *     outside the purged dir (`<base>/.turn-capture.lock`);
 *   - 30-day retention (maintenance cadence) + explicit `--purge`;
 *   - exporter isolation: `metrics-package.mjs` has no read path here, guarded
 *     by a planted-canary tripwire test.
 *
 * Failure-mode discipline: NEVER throws on the capture path, never blocks the
 * turn. Every attempt (success or failure) lands in a health counter
 * (`<stream>/capture-health.json`) so a silently dying flight recorder is
 * itself observable (Link 5 tripwire input).
 *
 * Ships with the plugin by convention; .mjs (Node.js) only.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';
import { resolveStoragePath, resolveWorkspaceId, metricsEnabled } from './log-event.mjs';

// Bump ONLY when the row contract changes in a way that would make an older
// reader misread rows.
export const TURN_CAPTURE_SCHEMA_VERSION = '1.0.0';

export const TURN_CAPTURE_DIRNAME = 'turn-capture';
export const TURN_CAPTURE_RETENTION_DAYS = 30;

// Byte caps: generous enough that the hindsight judge always has the real
// material (full-text lexical scoring saturates well below these), bounded so
// a pathological paste can't balloon the stream. Real UTF-8 byte offsets —
// never String.slice (the K-series UTF-16 lesson).
export const TURN_CAPTURE_MAX_PROMPT_BYTES = 65536;
export const TURN_CAPTURE_MAX_PACK_BYTES = 16384;

// Rejected candidates recorded per turn (ids + scores only). Top-N by the
// ranking the retriever itself used; the judge re-derives bodies from the
// store, with `store_signature` telling it whether the store drifted.
export const TURN_CAPTURE_MAX_REJECTED = 20;

// Owner-only modes (same rationale + best-effort semantics as rich-context).
export const TURN_CAPTURE_DIR_MODE = 0o700;
export const TURN_CAPTURE_FILE_MODE = 0o600;

// Health lives as a SIBLING of the stream dir (under the storage base), NOT
// inside it: if the stream dir itself can't be created — or the stream lock
// can't be acquired — the failure must still be recordable, or the flight
// recorder can die silently (exactly what the Link 5 capture-health tripwire
// watches for). Sitting outside the stream dir does not put it outside the
// purge: it is a declared purge-scope entry (turnCapturePurgeScope).
export const HEALTH_FILENAME = 'turn-capture-health.json';
// Judgments derive from captured rows and are keyed by their retrieval ids, so
// they belong to the captured material's lifecycle: the purge scope carries
// them. hindsight-judge.mjs and scorecard.mjs read this name from here so the
// stream has one owner for its own file names.
export const JUDGMENT_LOG_FILENAME = 'judgment-log.jsonl';
const DATE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Is the every-turn evidence layer active for this project?
 * Precedence (first match wins):
 *   1. aggregate metrics OFF (env/workspace metrics gate) → OFF.
 *   2. env `CORE_TURN_CAPTURE` false (0/false/no/off) → OFF; true → ON.
 *   3. project-root `workspace.json` `"turn_capture": false` → OFF.
 *   4. default → ON.
 */
export function turnCaptureEnabled({ project, env = process.env } = {}) {
  if (!metricsEnabled({ project, env })) return false;
  const flag = (env.CORE_TURN_CAPTURE || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false;
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    try {
      const p = JSON.parse(readFileSync(join(project, 'workspace.json'), 'utf8'));
      if (p && p.turn_capture === false) return false;
    } catch { /* no pointer / unparseable → default */ }
  }
  return true;
}

/** Absolute dir for this project's evidence stream. */
export function turnCaptureDir(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), TURN_CAPTURE_DIRNAME);
}

/** The ONE exclusion lock shared by append, retention, purge, and the health
 * counter — a stable sibling OUTSIDE the purged dir. */
export function turnCaptureLockPath(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), '.turn-capture.lock');
}

function hardenPath(target, mode) {
  try { chmodSync(target, mode); } catch { /* best-effort: not every FS supports chmod */ }
}

/** Byte-safe head: never splits a multi-byte UTF-8 sequence. */
function byteCapHead(str, maxBytes) {
  const clean = String(str ?? '').replace(CONTROL_CHARS_RE, '');
  const buf = Buffer.from(clean, 'utf8');
  if (buf.length <= maxBytes) return { head: clean, fullBytes: buf.length, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return { head: buf.subarray(0, end).toString('utf8'), fullBytes: buf.length, truncated: true };
}

function strOrNull(value, maxLen = 200) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(CONTROL_CHARS_RE, '').slice(0, maxLen);
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalize + bound one evidence row. `prompt_text` is REQUIRED (an evidence
 * row with no prompt has nothing to judge); everything else is best-effort so
 * partial context still records what it can.
 */
export function normalizeTurnEvidenceRow(input) {
  if (!input || typeof input !== 'object') throw new Error('turn-evidence row must be an object');
  const prompt = byteCapHead(input.prompt_text, TURN_CAPTURE_MAX_PROMPT_BYTES);
  if (!prompt.head.trim()) throw new Error('turn-evidence row: prompt_text must be a non-empty string');

  const delivered = (Array.isArray(input.delivered) ? input.delivered : []).map((d) => {
    const pack = byteCapHead(d && d.pack_text, TURN_CAPTURE_MAX_PACK_BYTES);
    return {
      id: strOrNull(d && d.id, 200),
      score: numOrNull(d && d.score),
      source_stage: strOrNull(d && d.source_stage, 40),
      pack_text: pack.head,
      pack_bytes: pack.fullBytes,
      pack_truncated: pack.truncated,
    };
  });

  const rejectedAll = Array.isArray(input.rejected_top) ? input.rejected_top : [];
  const rejected = rejectedAll
    .slice(0, TURN_CAPTURE_MAX_REJECTED)
    .map((r) => ({
      id: strOrNull(r && r.id, 200),
      score: numOrNull(r && r.score),
      source_stage: strOrNull(r && r.source_stage, 40),
    }));
  // Tail density: the score of the FIRST candidate the bound
  // dropped, so a reader knows how hot the truncated tail was. Null when
  // nothing was dropped.
  const rejectedCutoffScore = rejectedAll.length > TURN_CAPTURE_MAX_REJECTED
    ? numOrNull(rejectedAll[TURN_CAPTURE_MAX_REJECTED] && rejectedAll[TURN_CAPTURE_MAX_REJECTED].score)
    : null;

  const truncation = input.truncation && typeof input.truncation === 'object'
    ? {
        byte_cap_applied: Boolean(input.truncation.byte_cap_applied),
        prompt_tokens_used: numOrNull(input.truncation.prompt_tokens_used),
      }
    : { byte_cap_applied: null, prompt_tokens_used: null };

  // The combined delivered pack — the exact bytes the turn received. Kept at
  // row level because the product delivers ONE byte-capped pack, not per-unit
  // texts; per-unit pack_text stays optional for producers that have it.
  const pack = byteCapHead(input.pack_text, TURN_CAPTURE_MAX_PACK_BYTES);

  return {
    kind: 'turn-evidence',
    schema_version: TURN_CAPTURE_SCHEMA_VERSION,
    retrieval_id: strOrNull(input.retrieval_id, 200),
    session_id: strOrNull(input.session_id, 80),
    harness: strOrNull(input.harness, 40),
    prompt_text: prompt.head,
    prompt_bytes: prompt.fullBytes,
    prompt_truncated: prompt.truncated,
    pack_text: pack.head,
    pack_text_bytes: pack.fullBytes,
    pack_text_truncated: pack.truncated,
    delivered,
    rejected_top: rejected,
    rejected_cutoff_score: rejectedCutoffScore,
    truncation,
    store_signature: strOrNull(input.store_signature, 120),
    producer_version: strOrNull(input.producer_version, 24) || 'unknown',
    producer_sha: strOrNull(input.producer_sha, 44) || 'unknown',
  };
}

function todayUTC(now) {
  return (now ? new Date(now) : new Date()).toISOString().slice(0, 10);
}

/**
 * Cheap store snapshot marker for drift detection: the retriever's own summary
 * index (`_memories/_lib/unit-summaries.json`) is regenerated on any store
 * change (the R1 source-signature contract), so its size+mtime identifies the store
 * state a turn actually retrieved against. The hindsight judge records this
 * signature at capture AND at judge time; a mismatch flags the judgment as
 * store-drifted rather than pretending hindsight over a store that no longer
 * matches.
 */
export function computeStoreSignature(storeDir) {
  try {
    const s = statSync(join(storeDir, '_memories', '_lib', 'unit-summaries.json'));
    return `s${s.size}-m${Math.round(s.mtimeMs)}`;
  } catch { return 'unknown'; }
}

// Health counter — bumped on EVERY attempt, outside the stream lock, so a
// lock failure or unmakeable stream dir still gets recorded. Plain
// read-modify-write: two simultaneous processes can lose one increment.
// ponytail: benign race on a health counter; move under its own lock if
// tripwire precision ever needs exact counts.
function bumpHealth(projectDir, wsId, { failed, reason, ts }) {
  try {
    const base = resolveStoragePath(projectDir, { workspaceId: wsId });
    mkdirSync(base, { recursive: true });
    const file = join(base, HEALTH_FILENAME);
    let health = { attempts: 0, failures: 0, consecutive_failures: 0, last_failure_reason: null, last_failure_ts: null };
    try { health = { ...health, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* fresh */ }
    health.attempts += 1;
    if (failed) {
      health.failures += 1;
      // Streak feeds the tripwire floor: "10% failure rate with
      // ≥20 attempts, OR 3 consecutive failures" — the streak catches a
      // hard-dead recorder in a short session where the rate floor can't.
      health.consecutive_failures = (health.consecutive_failures || 0) + 1;
      health.last_failure_reason = String(reason || 'unknown').slice(0, 200);
      health.last_failure_ts = ts;
    } else {
      health.consecutive_failures = 0;
    }
    writeFileSync(file, JSON.stringify(health) + '\n');
    hardenPath(file, TURN_CAPTURE_FILE_MODE);
  } catch { /* best-effort — health must never fail the capture path */ }
}

/** Read the capture-health counters. Missing → zeros. */
export function readCaptureHealth(projectDir, { workspaceId } = {}) {
  const file = join(resolveStoragePath(projectDir, { workspaceId }), HEALTH_FILENAME);
  const zero = { attempts: 0, failures: 0, consecutive_failures: 0, last_failure_reason: null, last_failure_ts: null };
  try { return { ...zero, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { return zero; }
}

/**
 * Capture one turn's evidence. Self-guards on the gate (defense in depth — the
 * hook also checks) and never throws.
 *
 * @returns {{ written: boolean, reason?: string, path?: string }}
 */
export function captureTurnEvidence(projectDir, input, { workspaceId, now, env = process.env } = {}) {
  try {
    if (!existsSync(projectDir)) return { written: false, reason: 'project-dir-missing' };
    if (!turnCaptureEnabled({ project: projectDir, env })) {
      return { written: false, reason: 'disabled' };
    }
    const wsId = workspaceId || resolveWorkspaceId(projectDir);
    let row;
    try { row = normalizeTurnEvidenceRow(input); }
    catch (e) {
      // A rejected row is a live failure, not a non-event: a caller that stops
      // supplying a required field fails every turn. Counting it keeps the
      // failure-streak wire able to see it. An opt-out returns above this and
      // is never counted — declining to record is not a broken recorder.
      bumpHealth(projectDir, wsId, { failed: true, reason: `invalid-row: ${e.message}`, ts: new Date().toISOString() });
      return { written: false, reason: `invalid-row: ${e.message}` };
    }
    const record = { ts: now || new Date().toISOString(), ...row };
    const dir = turnCaptureDir(projectDir, { workspaceId: wsId });
    const file = join(dir, `${todayUTC(now)}.jsonl`);
    let appendError = null;
    try {
      withFileLock(turnCaptureLockPath(projectDir, { workspaceId: wsId }), () => {
        // mkdir + append + hardening inside the shared lock: a concurrent
        // purge can't race between mkdir and append, and owner-only modes are
        // re-asserted every write.
        try {
          mkdirSync(dir, { recursive: true, mode: TURN_CAPTURE_DIR_MODE });
          hardenPath(dir, TURN_CAPTURE_DIR_MODE);
          // Self-exclusion from git: the stream holds real conversation
          // content, and a git-tracked project would otherwise be one
          // `git add -A` away from committing it. The stream protects itself;
          // no project-level .gitignore is relied on.
          const gitignore = join(dir, '.gitignore');
          if (!existsSync(gitignore)) {
            writeFileSync(gitignore, '*\n');
            hardenPath(gitignore, TURN_CAPTURE_FILE_MODE);
          }
          appendFileSync(file, JSON.stringify(record) + '\n');
          hardenPath(file, TURN_CAPTURE_FILE_MODE);
        } catch (e) {
          appendError = e;
        }
      });
    } catch (e) {
      appendError = e; // lock acquisition failed — still an attempt, still recorded
    }
    bumpHealth(projectDir, wsId, {
      failed: Boolean(appendError),
      reason: appendError ? String(appendError.message) : null,
      ts: record.ts,
    });
    if (appendError) {
      return { written: false, reason: `capture-failed: ${String(appendError.message).slice(0, 120)}` };
    }
    return { written: true, path: file };
  } catch (e) {
    return { written: false, reason: `capture-failed: ${String(e && e.message).slice(0, 120)}` };
  }
}

// ---------- read-side ----------

/** List `<date>.jsonl` files in the stream dir, oldest first. */
export function listTurnCaptureFiles(projectDir, { workspaceId } = {}) {
  const dir = turnCaptureDir(projectDir, { workspaceId });
  if (!existsSync(dir)) return [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => DATE_FILE_RE.test(n))
    .sort()
    .map((n) => ({ date: n.slice(0, 10), file: join(dir, n) }));
}

/**
 * Cheap census for the /metrics mechanics line: whether the stream is on and
 * how much is captured. Row count is a line count (no per-row parse).
 */
export function turnCaptureStats(projectDir, { workspaceId, env = process.env } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const enabled = turnCaptureEnabled({ project: projectDir, env });
  const files = listTurnCaptureFiles(projectDir, { workspaceId: wsId });
  let rows = 0;
  for (const { file } of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) rows++;
    } catch { /* unreadable file contributes no rows */ }
  }
  return {
    enabled,
    days: files.length,
    rows,
    health: readCaptureHealth(projectDir, { workspaceId: wsId }),
    dir: turnCaptureDir(projectDir, { workspaceId: wsId }),
  };
}

// ---------- deletion ops (retention + purge) ----------
// BOUNDARY: every deletion is scoped to CORE's OWN capture files under
// `<storage-base>/turn-capture/`. Path assertions refuse anything else.

function assertInsideTurnCapture(targetFile, dir) {
  if (basename(dir) !== TURN_CAPTURE_DIRNAME) {
    throw new Error(`refusing deletion: stream dir is not named '${TURN_CAPTURE_DIRNAME}' (${dir})`);
  }
  if (dirname(targetFile) !== dir) {
    throw new Error(`refusing deletion: target escapes the turn-capture dir (${targetFile})`);
  }
  if (!DATE_FILE_RE.test(basename(targetFile))) {
    throw new Error(`refusing deletion: target is not a <date>.jsonl row file (${targetFile})`);
  }
}

/**
 * The declared scope of a purge — the ONE list every deletion path reads and
 * every purge report names. `stream` is removed whole (nested dirs, interrupted
 * partial writes, and the self-exclusion .gitignore go with it); `health` and
 * `judgments` are the supplement and the derivative that describe the same
 * captured material. The lock is deliberately NOT in scope: it holds no
 * captured content and is what serializes the purge itself.
 */
export function turnCapturePurgeScope(projectDir, { workspaceId } = {}) {
  const base = resolveStoragePath(projectDir, { workspaceId });
  return [
    { id: 'stream', path: join(base, TURN_CAPTURE_DIRNAME), tree: true },
    { id: 'health', path: join(base, HEALTH_FILENAME), tree: false },
    { id: 'judgments', path: join(base, JUDGMENT_LOG_FILENAME), tree: false },
  ];
}

// A destructive bound is validated before it can delete anything: an entry has
// to be a direct child of the storage base carrying its declared name.
function assertPurgeEntry(entry, base) {
  const expected = { stream: TURN_CAPTURE_DIRNAME, health: HEALTH_FILENAME, judgments: JUDGMENT_LOG_FILENAME }[entry.id];
  if (!expected || basename(entry.path) !== expected || dirname(entry.path) !== base) {
    throw new Error(`refusing purge: '${entry.path}' is not <storage-base>/${expected || entry.id}`);
  }
}

// A retention window drives deletion-cutoff arithmetic, so it is validated as a
// finite positive whole number of days before any candidate is even named.
function validWindow(windowDays) {
  return typeof windowDays === 'number' && Number.isInteger(windowDays) && windowDays >= 1;
}

/**
 * Retention pass: delete row files strictly older than `windowDays`.
 * Boundary-dated files are kept (end-of-day UTC interpretation).
 */
export function runTurnCaptureRetention(projectDir, {
  windowDays = TURN_CAPTURE_RETENTION_DAYS,
  apply = true,
  now = new Date().toISOString(),
  workspaceId,
} = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const dir = turnCaptureDir(projectDir, { workspaceId: wsId });
  const base = { windowDays, candidates: [], deleted: [], kept: [], verified: true };
  if (!validWindow(windowDays)) {
    return { ran: false, reason: 'invalid-window', cutoff: null, ...base, verified: false };
  }
  if (!existsSync(dir)) return { ran: false, reason: 'no-turn-capture-dir', cutoff: null, ...base };

  const cutoffMs = new Date(now).getTime() - windowDays * 86400000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  for (const { date, file } of listTurnCaptureFiles(projectDir, { workspaceId: wsId })) {
    const fileMs = new Date(`${date}T23:59:59Z`).getTime();
    if (fileMs >= cutoffMs) { base.kept.push(file); continue; }
    base.candidates.push(file);
  }

  if (!apply) return { ran: true, cutoff, ...base };

  try {
    withFileLock(turnCaptureLockPath(projectDir, { workspaceId: wsId }), () => {
      for (const file of base.candidates) {
        try {
          assertInsideTurnCapture(file, dir);
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
    base.verified = false;
    base.kept.push(`(retention-lock-unavailable: ${String(e && e.code || e && e.message).slice(0, 40)})`);
  }
  return { ran: true, cutoff, ...base };
}

/**
 * Purge every entry in the declared scope. Each entry is bound-checked before
 * deletion and verified after it, and the result names ALL of them — an entry
 * that could not be removed is reported with its reason and the overall result
 * is not `purged`. Partial success is never narrated as success.
 */
export function purgeTurnCapture(projectDir, { apply = true, workspaceId } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const dir = turnCaptureDir(projectDir, { workspaceId: wsId });
  const base = resolveStoragePath(projectDir, { workspaceId: wsId });
  const entries = turnCapturePurgeScope(projectDir, { workspaceId: wsId });
  try {
    for (const entry of entries) assertPurgeEntry(entry, base);
  } catch (e) {
    return { purged: false, reason: String(e && e.message), dir, existed: existsSync(dir), scope: [] };
  }

  const scope = entries.map((entry) => ({ ...entry, existed: existsSync(entry.path), removed: false }));
  const existed = scope.some((entry) => entry.existed);
  if (!apply) {
    return { purged: false, reason: 'dry-run', dir, existed, scope };
  }

  try {
    withFileLock(turnCaptureLockPath(projectDir, { workspaceId: wsId }), () => {
      for (const entry of scope) {
        try {
          rmSync(entry.path, { recursive: entry.tree, force: true });
          if (existsSync(entry.path)) entry.reason = 'still-present-after-delete';
          else entry.removed = true;
        } catch (e) {
          entry.reason = String(e && e.message).slice(0, 120);
        }
      }
    });
  } catch (e) {
    return { purged: false, reason: `purge-lock-unavailable: ${String(e && e.message).slice(0, 120)}`, dir, existed, scope };
  }

  const obstructed = scope.filter((entry) => !entry.removed);
  if (obstructed.length) {
    return {
      purged: false,
      reason: `purge incomplete: ${obstructed.map((entry) => `${entry.id} (${entry.reason})`).join('; ')}`,
      dir, existed, scope,
    };
  }
  return { purged: true, dir, existed, scope };
}

// ---------- CLI ----------
// Capture is called in-process from retrieve-context-hook.mjs; the CLI exists
// for status inspection and the operator deletion ops.

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
    process.stderr.write('usage: turn-capture.mjs <project-dir> [--status | --retention [--window N] [--apply] | --purge [--apply]]\n');
    return 1;
  }
  if (flags.get('purge')) {
    const res = purgeTurnCapture(projectDir, { apply: Boolean(flags.get('apply')) });
    process.stdout.write(JSON.stringify(res) + '\n');
    return res.purged || res.reason === 'dry-run' ? 0 : 2;
  }
  if (flags.get('retention')) {
    const windowDays = flags.get('window') ? Number(flags.get('window')) : TURN_CAPTURE_RETENTION_DAYS;
    const res = runTurnCaptureRetention(projectDir, { windowDays, apply: Boolean(flags.get('apply')) });
    process.stdout.write(JSON.stringify(res) + '\n');
    return res.reason === 'invalid-window' ? 2 : 0;
  }
  // default: status — enabled/effective state + volumes + health
  const files = listTurnCaptureFiles(projectDir);
  const stats = {
    enabled: turnCaptureEnabled({ project: projectDir }),
    days: files.length,
    health: readCaptureHealth(projectDir),
    dir: turnCaptureDir(projectDir),
  };
  process.stdout.write(JSON.stringify(stats) + '\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
