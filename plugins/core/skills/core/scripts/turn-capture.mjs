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
 * DEFAULT-ON with opt-outs:
 *   1. `CORE_METRICS_ENABLED` off → OFF (master kill switch; capture nests
 *      inside the metrics gate).
 *   2. `CORE_TURN_CAPTURE` env false → OFF (its own hard switch).
 *   3. the project's trusted manifest (`_core/<harness>/workspace.json`) `"turn_capture": false` → OFF. Unlike
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
 *   - kept until an explicit `--purge` (no scheduled deletion);
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

import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withFileLock, foreignLockArtifact } from './file-lock.mjs';
import { resolveStoragePath, prepareStorageDir, metricsEnabled, metricsHistoryFolders, metricsHistoryHeld, trustedMetricsDir } from './log-event.mjs';
import { projectRootFor, projectStateDir, localStateDir, stateHarnessesPartial, stateLocations, pathPresence, detectStateHarness, readManifest, manifestTurnCaptureOptsOutUnverified, readCaptureOptOuts } from './project-state.mjs';
import { isCliEntry } from './cli-entry.mjs';
import { closeStorageRoot, purgeGeneratedCloseDirectory } from './close-artifacts.mjs';
import { requireTrustedHome, coreHome } from './trusted-home.mjs';

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
// The classified turn log's own dirname, matching classify-turns.mjs's `join(..., 'classified')`.
// Named here (not imported from there) to avoid a circular import between the two modules.
export const CLASSIFIED_DIRNAME = 'classified';
const DATE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Is the every-turn evidence layer active for this project?
 * Precedence (first match wins):
 *   1. aggregate metrics OFF (env/workspace metrics gate) → OFF.
 *   2. env `CORE_TURN_CAPTURE` false (0/false/no/off) → OFF; true → ON.
 *   3. the project's trusted manifest (`_core/<harness>/workspace.json`), or the project-root
 *      `workspace.json`, says `"turn_capture": false` → OFF.
 *   4. default → ON.
 */
export let turnCaptureGateFailure = null;
let gateFailureSaid = false;

export function turnCaptureEnabled({ project, env = process.env, home: homeIn } = {}) {
  turnCaptureGateFailure = null;
  let home;
  try { home = homeIn ?? coreHome(); }
  catch (e) { turnCaptureGateFailure = String(e?.code || 'error'); return false; }   // no account home: OFF
  if (!metricsEnabled({ project, env, home })) return false;
  const flag = (env.CORE_TURN_CAPTURE || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false;
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    try {
      const coreDir = join(home, '.core');
      const m = readManifest({ root: projectRootFor(project, { home, coreDir }),
        harness: detectStateHarness(env), coreDir, throwReadErrors: true });
      if (m && m.turn_capture === false) return false;
      const root = projectRootFor(project, { home, coreDir: join(home, '.core') });
      // Read even beside a trusted manifest: an older `.core` left in the project may still say off.
      if (manifestTurnCaptureOptsOutUnverified({ root, harness: detectStateHarness(env) })) return false;
      // An older or copied project's root manifest may only switch capture off,
      // and has the same read-failure rule until the signed manifest carries it.
      if (readCaptureOptOuts(join(root, 'workspace.json')).turn_capture === false) return false;
    } catch (e) {
      turnCaptureGateFailure = String(e?.code || e?.name || 'error');
      if (!gateFailureSaid) {
        gateFailureSaid = true;
        try { process.stderr.write(`CORE turn-capture gate: could not read project state (${turnCaptureGateFailure}); capture is off for this run\n`); } catch { /* stderr closed */ }
      }
      return false;
    }
  }
  return true;
}

/** Absolute dir for this project's evidence stream. */
export function turnCaptureDir(projectDir) {
  return join(resolveStoragePath(projectDir), TURN_CAPTURE_DIRNAME);
}

/** The ONE exclusion lock shared by append, retention, purge, and the health
 * counter — a stable sibling OUTSIDE the purged dir. */
export function turnCaptureLockPath(projectDir) {
  return join(resolveStoragePath(projectDir), '.turn-capture.lock');
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
/**
 * Why capture must not write here, or null. Everything capture writes is CORE's own and belongs
 * physically in the project: the metrics folder and the stream folder must be real directories under
 * the project root, and the dated row, the stream's ignore file, the health file and the lock's files
 * must be regular files with a single name (a link, or a second hard link, is the same bytes living
 * somewhere else). Checked with lstat, before anything is created, read or appended. A path inside the
 * project is not proof of this; that is what the check is for.
 */
export function captureCustodyProblem(projectDir, { rowFile = null, healthOnly = false } = {}) {
  let root;
  // The project may itself be reached through a link; custody is judged against where it really is.
  try { root = realpathSync(resolve(projectDir)); if (!statSync(root).isDirectory()) throw new Error('not a directory'); } catch { return 'project root is not a real directory'; }
  const base = resolveStoragePath(projectDir);
  const dir = turnCaptureDir(projectDir);
  const rel = (p) => relative(resolve(projectDir), p) || '.';   // named as the caller sees it
  const kind = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  try {
    for (const d of healthOnly ? [base] : [base, dir]) {
      const st = kind(d);
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isDirectory()) return `${rel(d)} is a link or not a folder`;
      const real = realpathSync(d);
      if (real !== root && !real.startsWith(root + sep)) return `${rel(d)} is outside the project`;
    }
    if (!kind(base)) { let parent; try { parent = realpathSync(dirname(resolve(base))); } catch { parent = null; } if (parent !== root && !(parent || '').startsWith(root + sep)) return 'the metrics folder would be created outside the project'; }
    const leaves = healthOnly ? [join(base, HEALTH_FILENAME)] : [join(base, HEALTH_FILENAME), join(dir, '.gitignore'), ...(rowFile ? [rowFile] : [])];
    for (const f of leaves) {
      const st = kind(f);
      if (st && (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)) return `${rel(f)} is a link, has a second name, or is not a regular file`;
    }
    if (!healthOnly && kind(base)) {
      // Every generation and tombstone of the lock is read during acquisition. A link, or a hard
      // link from outside this folder, is refused; the lock's own momentary second name (it creates
      // a generation by linking a temp file beside it) is not.
      const lock = foreignLockArtifact(turnCaptureLockPath(projectDir));
      if (lock) return `${rel(join(base, lock))} is a link or has a name outside this folder`;
    }
  } catch (e) { return `capture location could not be checked (${e.code || e.message})`; }
  return null;
}

function bumpHealth(projectDir, { failed, reason, ts }) {
  try {
    // Health is best-effort, but never somewhere else: an unsafe location means no health write.
    if (captureCustodyProblem(projectDir, { healthOnly: true })) return;
    const base = prepareStorageDir(projectDir);
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

/**
 * Read the capture-health counters. Missing → zeros. A file that is there but can't be trusted
 * (unsafe location, unreadable, not a JSON object) → zeros plus `unreadable: <why>`, so no reader
 * mistakes a broken instrument for a quiet one.
 */
export function readCaptureHealth(projectDir) {
  const file = join(resolveStoragePath(projectDir), HEALTH_FILENAME);
  const zero = { attempts: 0, failures: 0, consecutive_failures: 0, last_failure_reason: null, last_failure_ts: null };
  const custody = captureCustodyProblem(projectDir, { healthOnly: true });
  if (custody) return { ...zero, unreadable: custody };
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return e.code === 'ENOENT' ? zero : { ...zero, unreadable: e.code || 'not valid JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...zero, unreadable: 'not a JSON object' };
  // Counters earn numeric credit only as whole numbers from zero up. One a file predates is zero;
  // a file with none of them is not a health record.
  const counters = ['attempts', 'failures', 'consecutive_failures'];
  if (!counters.some((k) => k in parsed)) return { ...zero, unreadable: 'no counters' };
  const bad = counters.find((k) => k in parsed && !(Number.isSafeInteger(parsed[k]) && parsed[k] >= 0));
  if (bad) return { ...zero, unreadable: `${bad} is not a whole number from zero up` };
  return { ...zero, ...parsed };
}

/**
 * Capture one turn's evidence. Self-guards on the gate (defense in depth — the
 * hook also checks) and never throws.
 *
 * @returns {{ written: boolean, reason?: string, path?: string }}
 */
export function captureTurnEvidence(projectDir, input, { now, env = process.env } = {}) {
  try {
    if (!existsSync(projectDir)) return { written: false, reason: 'project-dir-missing' };
    // The enabled check itself looks inside the metrics folder (the capture-disabled marker), so the
    // folder's custody comes first. Not counted in health: health lives in that same folder, and
    // whether this project opted out is not yet known.
    const early = captureCustodyProblem(projectDir, { healthOnly: true });
    if (early) return { written: false, reason: `capture-refused: ${early}`, refused: true };
    if (!turnCaptureEnabled({ project: projectDir, env })) {
      return { written: false, reason: 'disabled' };
    }
    let row;
    try { row = normalizeTurnEvidenceRow(input); }
    catch (e) {
      // A rejected row is a live failure, not a non-event: a caller that stops
      // supplying a required field fails every turn. Counting it keeps the
      // failure-streak wire able to see it. An opt-out returns above this and
      // is never counted — declining to record is not a broken recorder.
      bumpHealth(projectDir, { failed: true, reason: `invalid-row: ${e.message}`, ts: new Date().toISOString() });
      return { written: false, reason: `invalid-row: ${e.message}` };
    }
    const record = { ts: now || new Date().toISOString(), ...row };
    const dir = turnCaptureDir(projectDir);
    const file = join(dir, `${todayUTC(now)}.jsonl`);
    // Refused before the lock is taken or anything is created: nothing is read or written elsewhere.
    const unsafe = captureCustodyProblem(projectDir, { rowFile: file });
    if (unsafe) {
      bumpHealth(projectDir, { failed: true, reason: `capture-refused: ${unsafe}`, ts: record.ts });
      return { written: false, reason: `capture-refused: ${unsafe}`, refused: true };
    }
    let appendError = null;
    try {
      prepareStorageDir(projectDir);
      withFileLock(turnCaptureLockPath(projectDir), () => {
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
          // Checked again under the lock, immediately before the append.
          const late = captureCustodyProblem(projectDir, { rowFile: file });
          if (late) throw Object.assign(new Error(`capture-refused: ${late}`), { code: 'CAPTURE_REFUSED' });
          appendFileSync(file, JSON.stringify(record) + '\n');
          hardenPath(file, TURN_CAPTURE_FILE_MODE);
        } catch (e) {
          appendError = e;
        }
      });
    } catch (e) {
      appendError = e; // lock acquisition failed — still an attempt, still recorded
    }
    bumpHealth(projectDir, {
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
export function listTurnCaptureFiles(projectDir) {
  return dateFilesIn(turnCaptureDir(projectDir));
}

function dateFilesIn(dir) {
  if (!existsSync(dir)) return [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => DATE_FILE_RE.test(n))
    .sort()
    .map((n) => ({ date: n.slice(0, 10), file: join(dir, n) }));
}

// Row count is a line count (no per-row parse); an unreadable file contributes no rows.
function countRows(files) {
  let rows = 0;
  for (const { file } of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) rows++;
    } catch { /* unreadable file contributes no rows */ }
  }
  return rows;
}

/**
 * Cheap census for the /metrics mechanics line: whether the stream is on and
 * how much is captured. Row count is a line count (no per-row parse).
 */
export function turnCaptureStats(projectDir, { env = process.env, home } = {}) {
  // The selected home reaches the gate and the history lookup, so one report consults one account root.
  const homeOpt = home ? { home } : {};
  const enabled = turnCaptureEnabled({ project: projectDir, env, ...homeOpt });
  const files = listTurnCaptureFiles(projectDir);
  const history = metricsHistoryFolders(projectDir, { env, ...homeOpt }).map(({ folder }) => {
    const found = dateFilesIn(join(folder, TURN_CAPTURE_DIRNAME));
    return { dir: join(folder, TURN_CAPTURE_DIRNAME), days: found.length, rows: countRows(found) };
  });
  return {
    enabled,
    days: files.length,
    rows: countRows(files),
    health: readCaptureHealth(projectDir),
    dir: turnCaptureDir(projectDir),
    history,
  };
}

// ---------- deletion ops (retention + purge) ----------
// BOUNDARY: retention only touches dated turn-capture rows. Explicit purge
// uses the declared scope below, with marker/integrity selection for close files.

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
 * captured material. Close scopes remove only intact automatic-writer-marked
 * files, preserving manual/edited/history files and the containing directories.
 * The lock is deliberately NOT in scope: it holds no
 * captured content and is what serializes the purge itself.
 */
export function turnCapturePurgeScope(projectDir, { home = requireTrustedHome(), env = process.env } = {}) {
  const base = resolveStoragePath(projectDir, { home, env });
  // classify-turns.mjs writes full user/assistant text and tool events to a SEPARATE
  // store (the project's own operational-meta dir, never externally redirected — the
  // pin/AppData rules that apply to `base` above don't apply here). The disclosed purge
  // has to reach it too, or "purge everything saved" is false: nothing else deletes it
  // now that classified retention is no longer run on a schedule. Planning a purge only reads
  // state: a writing resolver would set aside state it cannot verify, moving the records the
  // history check needs before it looks. Without trusted state the path is computed, never
  // created; state that exists but does not verify is reported by metricsHistoryHeld.
  const coreDir = join(home, '.core');
  const classifiedBase = trustedMetricsDir(projectDir, { home, env })
    || join(projectStateDir({ root: projectRootFor(projectDir, { home, coreDir }), harness: detectStateHarness(env), kind: 'hot', coreDir }).dir, 'metrics');
  const closeBase = join(closeStorageRoot(projectDir, { home, env }), 'close');
  // Where each entry may physically be: the project folder, and for the classified log also this
  // project's machine-local fallback state (`~/.core/local/<project>/`), which holds it when the
  // project folder is unregistered or not writable. Checked again at deletion time.
  const root = projectRootFor(projectDir, { home, coreDir });
  const inProject = [projectDir];
  const inProjectOrLocal = (harness = detectStateHarness(env)) => [projectDir, dirname(localStateDir({ root, harness, coreDir }))];
  // The classified log is the same captured data in every place a harness's state can be, routed
  // there today or not (the project folder and the machine-local fallback); each one this project
  // can read as its own is purged. Places it can't are reported by metricsHistoryHeld.
  const running = detectStateHarness(env);
  const otherClassified = [];
  const seen = new Set([join(classifiedBase, CLASSIFIED_DIRNAME)]);
  const { harnesses } = stateHarnessesPartial({ root, coreDir, include: [running] }); // listing problems are reported as held
  for (const harness of harnesses) {
    let locations = [];
    try { ({ locations } = stateLocations({ root, harness, coreDir })); } catch { /* reported as held */ }
    for (const loc of locations) {
      const path = join(loc.dir, 'metrics', CLASSIFIED_DIRNAME);
      // Only a missing log is skipped: one that can't be looked at is planned, so its removal fails visibly.
      if (seen.has(path) || pathPresence(path).state === 'absent') continue;
      seen.add(path);
      otherClassified.push({ id: 'classified', harness, path, tree: true, base: join(loc.dir, 'metrics'), within: loc.kind === 'project' ? inProject : [loc.keyDir] });
    }
  }
  return [
    { id: 'stream', path: join(base, TURN_CAPTURE_DIRNAME), tree: true, base, within: inProject },
    { id: 'health', path: join(base, HEALTH_FILENAME), tree: false, base, within: inProject },
    { id: 'judgments', path: join(base, JUDGMENT_LOG_FILENAME), tree: false, base, within: inProject },
    { id: 'classified', path: join(classifiedBase, CLASSIFIED_DIRNAME), tree: true, base: classifiedBase, within: inProjectOrLocal() },
    ...otherClassified,
    { id: 'close-summaries', path: join(closeBase, 'summaries'), tree: false, generatedClose: true, base: closeBase, within: inProject },
    { id: 'close-receipts', path: join(closeBase, 'receipts'), tree: false, generatedClose: true, base: closeBase, within: inProject },
  ];
}

// The allowed roots are pinned when the purge is planned (their real path and file identity), and
// each entry is checked against the pins at the moment of deletion: a root replaced or relinked
// after planning cannot carry its authority to a new place, the entry's folder must resolve inside
// a pinned root, and the entry must not be a link. Limit: the interval between this check and the
// removal itself is not closed; CORE does not defend against a same-user process racing the
// filesystem inside it (the same boundary the close artifacts state).
function pinRoots(roots, coreDir) {
  const localRoot = join(coreDir, 'local');
  return roots.map((r) => {
    try {
      // A machine-local fallback folder is this project's only at its own spot under ~/.core/local:
      // a link there, or one that resolves elsewhere, is not pinned, so nothing inside it is purged.
      if (dirname(r) === localRoot) {
        if (lstatSync(r).isSymbolicLink()) return null;
        if (realpathSync.native(r) !== join(realpathSync.native(localRoot), basename(r))) return null;
      }
      const real = realpathSync.native(r); const st = statSync(real); return { root: r, real, dev: st.dev, ino: st.ino };
    }
    catch { return null; }
  });
}

function assertPhysicallyWithin(entry) {
  let real;
  try { real = realpathSync.native(entry.base); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const inside = entry.pins.some((pin) => {
    if (!pin) return false;
    let now;
    try { now = realpathSync.native(pin.root); } catch { return false; }
    if (now !== pin.real) return false;
    const st = statSync(pin.real);
    if (st.dev !== pin.dev || st.ino !== pin.ino) return false;
    const rel = relative(pin.real, real);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  });
  if (!inside) throw new Error(`refusing purge: ${entry.base} resolves to ${real}, not inside the folders pinned when the purge was planned`);
  let st = null;
  try { st = lstatSync(entry.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isSymbolicLink()) throw new Error(`refusing purge: ${entry.path} is a link`);
}

// A destructive bound is validated before it can delete anything: an entry has
// to be a direct child of its OWN declared base (not necessarily the same base
// every entry shares — classified lives under a different store than the rest).
function assertPurgeEntry(entry) {
  const expected = { stream: TURN_CAPTURE_DIRNAME, health: HEALTH_FILENAME, judgments: JUDGMENT_LOG_FILENAME, classified: CLASSIFIED_DIRNAME, 'close-summaries': 'summaries', 'close-receipts': 'receipts' }[entry.id];
  if (!expected || basename(entry.path) !== expected || dirname(entry.path) !== entry.base) {
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
} = {}) {
  const dir = turnCaptureDir(projectDir);
  const base = { windowDays, candidates: [], deleted: [], kept: [], verified: true };
  if (!validWindow(windowDays)) {
    return { ran: false, reason: 'invalid-window', cutoff: null, ...base, verified: false };
  }
  if (!existsSync(dir)) return { ran: false, reason: 'no-turn-capture-dir', cutoff: null, ...base };

  const cutoffMs = new Date(now).getTime() - windowDays * 86400000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  for (const { date, file } of listTurnCaptureFiles(projectDir)) {
    const fileMs = new Date(`${date}T23:59:59Z`).getTime();
    if (fileMs >= cutoffMs) { base.kept.push(file); continue; }
    base.candidates.push(file);
  }

  if (!apply) return { ran: true, cutoff, ...base };

  try {
    withFileLock(turnCaptureLockPath(projectDir), () => {
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
export function purgeTurnCapture(projectDir, { apply = true, home = requireTrustedHome(), env = process.env, beforeEntryDelete } = {}) {
  const dir = join(resolveStoragePath(projectDir, { home, env }), TURN_CAPTURE_DIRNAME);
  // What this purge cannot cover is worked out first, read-only, and carried in every result,
  // including a failed one: a false status alone does not say what is still owed.
  let heldHistory;
  try { heldHistory = metricsHistoryHeld(projectDir, { home, env }); }
  catch (e) { heldHistory = [{ what: projectDir, reason: `whether earlier rows exist could not be worked out (${String(e && (e.code || e.message)).slice(0, 80)})` }]; }
  let entries;
  try {
    entries = turnCapturePurgeScope(projectDir, { home, env });
    for (const entry of entries) assertPurgeEntry(entry);
  } catch (e) {
    return { purged: false, reason: String(e && e.message), dir, existed: existsSync(dir), scope: [], held_history: heldHistory };
  }

  const pinned = new Map();
  for (const entry of entries) for (const r of entry.within) if (!pinned.has(r)) pinned.set(r, pinRoots([r], join(home, '.core'))[0]);
  const scope = entries.map((entry) => ({ ...entry, pins: entry.within.map((r) => pinned.get(r)), existed: existsSync(entry.path), removed: false }));
  const existed = scope.some((entry) => entry.existed);
  if (!apply) {
    for (const entry of scope.filter(e => e.generatedClose)) {
      try { Object.assign(entry, purgeGeneratedCloseDirectory(entry.path)); }
      catch (e) { entry.reason = String(e.message).slice(0, 120); }
    }
    return { purged: false, reason: 'dry-run', dir, existed, scope, held_history: heldHistory };
  }

  try {
    withFileLock(join(resolveStoragePath(projectDir, { home, env }), '.turn-capture.lock'), () => {
      for (const entry of scope) {
        try {
          // Test seam: lets a test change the filesystem after planning, before this entry's checks.
          if (typeof beforeEntryDelete === 'function') beforeEntryDelete(entry);
          assertPhysicallyWithin(entry);
          if (entry.generatedClose) {
            Object.assign(entry, purgeGeneratedCloseDirectory(entry.path, { apply: true }));
            entry.removed = true; // selected generated files, NOT the directory or kept files
            continue;
          }
          rmSync(entry.path, { recursive: entry.tree, force: true });
          if (existsSync(entry.path)) entry.reason = 'still-present-after-delete';
          else entry.removed = true;
        } catch (e) {
          entry.reason = String(e && e.message).slice(0, 120);
        }
      }
    });
  } catch (e) {
    return { purged: false, reason: `purge-lock-unavailable: ${String(e && e.message).slice(0, 120)}`, dir, existed, scope, held_history: heldHistory };
  }

  const obstructed = scope.filter((entry) => !entry.removed);
  if (obstructed.length) {
    return {
      purged: false,
      reason: `purge incomplete: ${obstructed.map((entry) => `${entry.id} (${entry.reason})`).join('; ')}`,
      dir, existed, scope, held_history: heldHistory,
    };
  }
  // Earlier rows outside the project are never deleted here: they are named, with the reason, and
  // the purge does not count itself complete while they exist.
  if (heldHistory.length) {
    return {
      purged: false,
      reason: `history not purged: ${heldHistory.map((h) => `${h.what} (${h.reason})`).join('; ')}`,
      dir, existed, scope, held_history: heldHistory,
    };
  }
  return { purged: true, dir, existed, scope, held_history: [] };
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
  // default: status — enabled/effective state + volumes (project and history separately) + health
  process.stdout.write(JSON.stringify(turnCaptureStats(projectDir)) + '\n');
  return 0;
}

if (isCliEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
