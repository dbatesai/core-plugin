/**
 * memory-view-watch.mjs — change DETECTOR for the /memory-view live loop.
 * It never renders, publishes, or writes into the store (snapshot reads go
 * through collectUnits with the derived-cache refresh disabled). Job: notice
 * that the store's scoped content identity no longer matches the last
 * published snapshot id, say so once on stdout, and exit; the supervising
 * agent rebuilds/republishes and re-arms. Exit-on-detect is deliberate — the
 * EXIT of the harness background task is what wakes the supervising agent.
 *
 * CLI (arm mode):
 *   node memory-view-watch.mjs <project> [--debounce-ms 250]
 *        [--sweep-interval-ms 300000] [--baseline-snapshot <id>]
 *        [--timeout-ms 14400000] [--scope active|all-including-archive]
 *        [--live-state <path>]
 * CLI (loop-state write mode — composes and atomically replaces the record):
 *   node memory-view-watch.mjs --write-live-state <path>
 *        --artifact-url <url> --scope <scope> --baseline-snapshot <id>
 *        --grant-basis <text> [--exclude-topic <t>]...
 *        [--publish-count N] [--window-start ISO] [--retry-at ISO]
 *
 * stdout protocol — TERMINAL lines (one JSON line, then exit):
 *   {"event":"store-changed","snapshot_id":"…","units_seen":N,
 *    "trigger":"watch|sweep","observed_at":"ISO"}            → exit 0
 *   {"event":"idle-timeout","waited_ms":N,"observed_at":"ISO"} → exit 2
 *   {"event":"stopped","signal":"SIGTERM|SIGINT","observed_at":"ISO"} → exit 3
 *   {"event":"orphaned","parent_pid":N,"observed_at":"ISO"}   → exit 4
 * stdout protocol — STATUS lines (non-terminal; the process KEEPS RUNNING):
 *   {"event":"degraded","reason":"emfile","mode":"sweep-only",
 *    "sweep_interval_ms":N,"observed_at":"ISO"}
 *   {"event":"check-failed","reason":"store-read-incomplete",
 *    "read_errors":N,"trigger":"watch|sweep","observed_at":"ISO"}
 * Consumers dispatch on `event`, never on line position. Usage/config errors
 * exit 1; an explicit --live-state record the watcher cannot honor is a
 * config error (exit 1, named reason), never a silent default. If the ONE
 * terminal emit fails (EPIPE), the process exits 1: exit 0 always means "the
 * store-changed line landed", never "I tried".
 *
 * Contracts that are not obvious from the code:
 *  - Scoped identity: compare only the EXACT id collectUnits receipts for the
 *    armed scope AND exclusion list; never a raw signature, never across
 *    scopes. An unlabeled baseline is matched against both canonical ids at
 *    the first check and the scope locked from whichever it came from.
 *  - Incomplete reads NEVER wake: a check whose store traversal hit I/O
 *    errors (capture.readErrors — total fd exhaustion, EACCES, EIO) holds the
 *    baseline and emits a check-failed status; evidence of absence caused by
 *    resource failure is not a change. A genuinely empty store has no read
 *    errors and still compares normally.
 *  - fs.watch exhaustion (EMFILE/ENFILE/ENOSPC) DEGRADES to sweep-only, one
 *    "degraded" status line; the sweep interval becomes the detection SLO.
 *    Any other watch error exits 1 for a healthy restart.
 *  - ONE recursive directory watch (per-file watchers go deaf after atomic
 *    tmp+rename and blow the fd budget); eventType is never branched on
 *    (unreliable per Node docs — an event only means "go check"); trailing
 *    debounce + in-flight guard + dirty flag coalesce bursts to one check and
 *    never lose a mid-check write; the periodic mtime sweep is REQUIRED
 *    recovery for silently-dropped FSEvents, not optional hardening.
 *  - Orphan self-check: no platform guarantees a background child dies with
 *    its session, so the watcher probes its parent (signal-0 + POSIX reparent
 *    drift) every 500ms and exits 4 the moment it is gone.
 *  - Live-loop state: one JSON record (kind LIVE_STATE_KIND), schema-checked
 *    by assertLiveState at BOTH boundaries — the writer refuses to compose an
 *    invalid record (grant_basis required: the prospective consent basis) and
 *    the arm-mode reader refuses an explicit record it cannot honor.
 *    retry_at defers all comparisons until it passes (publish budget).
 */

import { watch as fsWatch, readdirSync, statSync, existsSync, writeSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { collectUnits } from './render-browse-artifact.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { isCliEntry } from './cli-entry.mjs';

export const DEFAULT_DEBOUNCE_MS = 250;
export const DEFAULT_SWEEP_INTERVAL_MS = 300000; // 5 min
export const DEFAULT_TIMEOUT_MS = 14400000;      // 4 h idle
// Slowest interval that still beats the session-teardown SLO (~1.5s): an
// orphan dies well under a second past its owner without burning 20 syscalls
// per second for hours.
export const ORPHAN_CHECK_INTERVAL_MS = 500;

export const WATCH_SCOPES = ['active', 'all-including-archive'];
// fs.watch failures that mean "resources exhausted, the process itself is
// fine" — these degrade to sweep-only; anything else still exits 1.
export const RESOURCE_ERROR_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC']);
export const LIVE_STATE_KIND = 'core-memory-view-live-state';

// Basename shapes that never count as a store change: tmp files, dotfiles
// (fs-atomic.mjs's sibling `.name.tmp-*` writes are dotfiles), editor backups.
const IGNORED_BASENAME = /\.tmp$|^\.|~$/;

/**
 * shouldIgnoreRel — event/sweep filter over a path RELATIVE to _memories/.
 * Ignored: dotfile segments, `_lib` segments, IGNORED_BASENAME finals. A
 * null/undefined filename (fs.watch may legally deliver one) counts as an
 * unfilterable hint. Over-filtering can only delay detection to the sweep —
 * the content-derived snapshot id stays the single arbiter of "changed".
 */
export function shouldIgnoreRel(rel) {
  if (rel === null || rel === undefined) return false;
  const segs = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length === 0) return false;
  for (const s of segs) {
    if (s === '_lib' || s.startsWith('.')) return true;
  }
  return IGNORED_BASENAME.test(segs[segs.length - 1]);
}

/**
 * sweepStatSet — recursive readdir+stat over _memories/ into a sorted
 * `path:mtimeMs:size` signature (same name filter as the event path). Pure
 * read, independent of fs.watch — this is what still sees a change after
 * FSEvents drops events. Exported for direct testing.
 */
export function sweepStatSet(memoriesDir) {
  const out = [];
  const walkDir = (dir, relPrefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relPrefix + e.name;
      if (shouldIgnoreRel(rel)) continue;
      if (e.isDirectory()) { walkDir(join(dir, e.name), rel + '/'); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = statSync(join(dir, e.name)); } catch { continue; } // vanished mid-walk
      out.push(`${rel}:${st.mtimeMs}:${st.size}`);
    }
  };
  walkDir(memoriesDir, '');
  return out.sort().join('|');
}

/**
 * computeCurrentSnapshot — the store's current identity for a scope and
 * exclusion list, from the SAME producer the renderer receipts (collectUnits,
 * read-only). activeSnapshotId rides along (the PLAIN store id, exclusions
 * not applied) so an unlabeled-baseline caller can match both canonical ids.
 * readErrors carries the capture's I/O failures — a caller must treat any
 * read error as "identity unknown", never as a changed store.
 */
export function computeCurrentSnapshot(projectDir, { scope = 'active', excludeTopics = [] } = {}) {
  const c = collectUnits(projectDir, { scope, excludeTopics });
  return {
    snapshotId: c.snapshotId,
    activeSnapshotId: c.activeSnapshotId,
    unitsSeen: c.units.length,
    activeUnitsSeen: c.units.filter((u) => u.population === 'active').length,
    readErrors: c.readErrors || [],
  };
}

/**
 * createCoalescer — trailing debounce + in-flight guard + dirty flag:
 *   on event  → mark dirty; restart the trailing timer
 *   maybeRun  → if a check is in flight, return (the flag survives);
 *               otherwise clear the flag, run, and if a change landed
 *               mid-check run EXACTLY ONE follow-up.
 * Without the dirty flag a file saved during a check is silently lost until
 * the next unrelated event. Exported for deterministic testing.
 */
export function createCoalescer({ debounceMs, check, onError = () => {} }) {
  let timer = null;
  let dirty = false;
  let running = false;

  async function maybeRun(trigger) {
    if (running) return;
    // A clear flag here means a STALE debounce timer whose work was already
    // consumed by the post-check follow-up; running anyway would double it.
    if (!dirty) return;
    running = true;
    dirty = false;
    try { await check(trigger); } catch (e) { onError(e); }
    running = false;
    if (dirty) await maybeRun(trigger);
  }

  return {
    // fs.watch path: debounced trailing-edge.
    notify(trigger = 'watch') {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; maybeRun(trigger); }, debounceMs);
    },
    // sweep path: immediate but guarded — never overlaps a running check.
    request(trigger) {
      dirty = true;
      return maybeRun(trigger);
    },
    stop() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

/**
 * assertLiveState — THE loop-state schema check, used at both boundaries:
 * writeLiveState refuses to compose an invalid record, and the arm-mode CLI
 * refuses to arm from one. Throws a named Error naming the first violation.
 */
export function assertLiveState(record) {
  const fail = (msg) => { throw new Error(`live-state record invalid: ${msg}`); };
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('not a JSON object');
  if (record.kind !== LIVE_STATE_KIND) fail(`kind must be "${LIVE_STATE_KIND}", got ${JSON.stringify(record.kind)}`);
  if (typeof record.artifact_url !== 'string' || record.artifact_url.trim() === '') fail('artifact_url must be a non-empty string');
  if (!WATCH_SCOPES.includes(record.scope)) fail(`scope must be one of ${WATCH_SCOPES.join(', ')}, got ${JSON.stringify(record.scope)}`);
  if (!Array.isArray(record.excluded_topics) || record.excluded_topics.some((t) => typeof t !== 'string')) fail('excluded_topics must be an array of strings');
  if (typeof record.grant_basis !== 'string' || record.grant_basis.trim() === '') fail('grant_basis must be a non-empty string (the prospective grant this loop runs under)');
  if (typeof record.baseline_snapshot !== 'string' || record.baseline_snapshot.trim() === '') fail('baseline_snapshot must be a non-empty string');
  const b = record.publish_budget;
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('publish_budget must be an object');
  if (typeof b.window_start !== 'string' || !Number.isFinite(Date.parse(b.window_start))) fail('publish_budget.window_start must be an ISO timestamp');
  if (!Number.isInteger(b.count) || b.count < 0) fail('publish_budget.count must be a non-negative integer');
  if (record.retry_at !== null && record.retry_at !== undefined
      && (typeof record.retry_at !== 'string' || !Number.isFinite(Date.parse(record.retry_at)))) {
    fail('retry_at must be null or an ISO timestamp');
  }
  return record;
}

/**
 * readLiveState — fail-soft read for library callers: absent, unparsable, or
 * non-object → null. The strictness lives at the CLI arm boundary, which
 * refuses (exit 1) when an EXPLICIT --live-state record is null or fails
 * assertLiveState — arming without a record the caller named would silently
 * reset scope/baseline and can lose a deferred publish.
 */
export function readLiveState(path) {
  try {
    const st = JSON.parse(readFileSync(path, 'utf8'));
    return st && typeof st === 'object' && !Array.isArray(st) ? st : null;
  } catch { return null; }
}

/**
 * writeLiveState — compose, VALIDATE, and atomically replace the whole
 * loop-state record (sibling-tmp + rename; a reader never sees a half-written
 * record). Whole-record replace, no merge: the supervisor re-states
 * scope/exclusions/baseline on every write, so a refresh cannot silently
 * drop them. Returns the record written.
 */
export function writeLiveState(path, {
  artifactUrl, scope, excludeTopics = [], baselineSnapshot,
  publishCount = 0, windowStart = null, retryAt = null,
  grantBasis = null, now = () => new Date(),
} = {}) {
  if (!artifactUrl) throw new Error('--write-live-state requires --artifact-url');
  if (!WATCH_SCOPES.includes(scope)) throw new Error(`--write-live-state requires --scope ${WATCH_SCOPES.join('|')}`);
  if (!baselineSnapshot) throw new Error('--write-live-state requires --baseline-snapshot');
  if (typeof grantBasis !== 'string' || grantBasis.trim() === '') {
    throw new Error('--write-live-state requires a non-empty --grant-basis: the record is armable only with its prospective grant recorded');
  }
  if (!Number.isInteger(publishCount) || publishCount < 0) {
    throw new Error(`publish_budget.count (--publish-count) must be a non-negative integer, got ${JSON.stringify(publishCount)}`);
  }
  const isoOrNull = (flag, v) => {
    if (v === null || v === undefined) return null;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new Error(`${flag} must be an ISO timestamp, got ${JSON.stringify(v)}`);
    return new Date(t).toISOString();
  };
  const record = {
    kind: LIVE_STATE_KIND,
    artifact_url: String(artifactUrl),
    scope,
    excluded_topics: excludeTopics.map(String),
    // The standing grant this loop runs under, bound to the scope and
    // exclusions above — future republishes are authorized only within them.
    grant_basis: String(grantBasis),
    baseline_snapshot: String(baselineSnapshot),
    publish_budget: {
      window_start: isoOrNull('--window-start', windowStart) || now().toISOString(),
      count: publishCount,
    },
    retry_at: isoOrNull('--retry-at', retryAt),
    updated_at: now().toISOString(),
  };
  assertLiveState(record); // same schema check the reader boundary applies
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWriteFileSync(abs, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * startWatcher — arm everything and return a handle. All effects are
 * injectable (emit/status/exit/diag/watchFn) so tests can run it in-process.
 *
 * Ordering contract: fs.watch arms BEFORE the initial read (a write landing
 * during the read still produces an event); then ONE initial check runs — a
 * provided baseline catches anything that changed between the last publish
 * and this arm (the recovery for a previous watcher's detection-to-exit
 * window). Without a baseline, the current id becomes the baseline. `armed`
 * resolves after the initial check.
 */
export function startWatcher({
  projectDir,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baselineSnapshot = null,
  scope = null,        // explicit scope; null → locked from the baseline at the first check
  excludeTopics = [],  // topic exclusions; part of the compared identity
  retryAtMs = null,    // publish-budget deferral: hold every comparison until this epoch-ms
  parentPid = null,    // owner process to outlive-check (CLI passes process.ppid); null → no check
  emit = (obj) => writeSync(1, JSON.stringify(obj) + '\n'),
  status = (obj) => writeSync(1, JSON.stringify(obj) + '\n'),
  exit = (code) => process.exit(code),
  diag = (msg) => { try { writeSync(2, `memory-view-watch: ${msg}\n`); } catch { /* stderr gone */ } },
  watchFn = fsWatch,
  now = () => new Date(),
}) {
  const root = resolve(projectDir);
  const memoriesDir = join(root, '_memories');
  if (!existsSync(memoriesDir)) {
    diag(`no _memories store at ${memoriesDir}`);
    exit(1);
    return null; // only reachable when `exit` is an injected non-throwing stub
  }

  let baseline = baselineSnapshot || null;
  let lockedScope = scope;
  let lastSweepSet = null;
  let finished = false;
  let degraded = false;
  let watcher = null;
  const timers = [];

  const stopAll = () => {
    finished = true;
    coalescer.stop();
    for (const t of timers) clearTimeout(t);
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  };

  const finish = (obj, code) => {
    if (finished) return;
    stopAll();
    try {
      emit(obj);
    } catch (e) {
      diag(`emit failed (${(e && e.code) || e}) — the stdout wake line did not land; exiting 1 so exit 0 stays unambiguous`);
      exit(1);
      return;
    }
    exit(code);
  };

  const changed = (snapshotId, unitsSeen, trigger) => finish({
    event: 'store-changed',
    snapshot_id: snapshotId,
    units_seen: unitsSeen,
    trigger,
    observed_at: now().toISOString(),
  }, 0);

  // Incomplete store read: no comparison is trustworthy, so hold the baseline
  // and stay armed — the next sweep retries against a (hopefully) healthy fs.
  const holdIncomplete = (readErrorCount, trigger) => {
    status({
      event: 'check-failed',
      reason: 'store-read-incomplete',
      read_errors: readErrorCount,
      trigger,
      observed_at: now().toISOString(),
    });
    diag(`store read incomplete (${readErrorCount} read error(s)) on ${trigger} check — holding baseline; the next sweep retries`);
  };

  // The check: recompute the scoped, exclusion-aware snapshot id; a mismatch
  // against the baseline reports once and finishes. Content-derived, so a
  // check triggered by junk can never emit a false change — and read-error
  // aware, so a collapsed read can never fabricate one either.
  async function check(trigger) {
    if (finished) return;
    if (retryAtMs !== null && Date.now() < retryAtMs) return; // deferral holds everything
    // Yield once so fs events queued behind a burst can set the dirty flag
    // before this read starts.
    await new Promise((r) => setImmediate(r));
    if (finished) return;
    if (lockedScope === null) {
      // Unlabeled baseline: match against BOTH canonical scoped ids and lock
      // the scope it came from (never compare across scopes or to a raw
      // signature — the incomparable-identity defect).
      const cur = computeCurrentSnapshot(root, { scope: 'all-including-archive', excludeTopics });
      if (cur.readErrors.length > 0) { holdIncomplete(cur.readErrors.length, trigger); return; }
      // With exclusions the active id must also be exclusion-aware; the plain
      // activeSnapshotId only stands in when no exclusions apply.
      const act = excludeTopics.length === 0
        ? { snapshotId: cur.activeSnapshotId, unitsSeen: cur.activeUnitsSeen, readErrors: [] }
        : computeCurrentSnapshot(root, { scope: 'active', excludeTopics });
      if (act.readErrors.length > 0) { holdIncomplete(act.readErrors.length, trigger); return; }
      if (baseline === null) { baseline = act.snapshotId; lockedScope = 'active'; return; }
      if (cur.snapshotId === baseline) { lockedScope = 'all-including-archive'; return; }
      lockedScope = 'active';
      if (act.snapshotId !== baseline) changed(act.snapshotId, act.unitsSeen, trigger);
      return;
    }
    const cur = computeCurrentSnapshot(root, { scope: lockedScope, excludeTopics });
    if (cur.readErrors.length > 0) { holdIncomplete(cur.readErrors.length, trigger); return; }
    if (baseline === null) { baseline = cur.snapshotId; return; } // first arm, no baseline given
    if (cur.snapshotId !== baseline) changed(cur.snapshotId, cur.unitsSeen, trigger);
  }

  const coalescer = createCoalescer({
    debounceMs,
    check,
    onError: (e) => diag(`check failed: ${e && e.message ? e.message : e}`),
  });

  // Resource exhaustion → sweep-only mode: close the (possibly dead) watch
  // handle, one status line, and the already-independent sweep carries
  // detection at its interval until the supervising loop re-arms.
  const degrade = (e) => {
    if (degraded || finished) return;
    degraded = true;
    if (watcher) { try { watcher.close(); } catch { /* already dead */ } watcher = null; }
    status({
      event: 'degraded',
      reason: String((e && e.code) || 'watch-error').toLowerCase(),
      mode: 'sweep-only',
      sweep_interval_ms: sweepIntervalMs,
      observed_at: now().toISOString(),
    });
    diag(`fs.watch unavailable (${(e && e.code) || e}) — degraded to sweep-only; detection latency is the sweep interval (${sweepIntervalMs}ms) until re-arm`);
  };

  // ONE recursive directory watch; trivial callback (filter, flag, timer) —
  // a slow callback is what overflows the FSEvents buffer.
  try {
    watcher = watchFn(memoriesDir, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnoreRel(filename)) return;
      coalescer.notify('watch');
    });
  } catch (e) {
    if (RESOURCE_ERROR_CODES.has(e && e.code)) {
      degrade(e); // arm-time exhaustion: sweep-only from the start, not exit 1
    } else {
      diag(`fs.watch failed: ${e && e.message ? e.message : e}`);
      exit(1);
      return null;
    }
  }
  if (watcher) {
    watcher.on('error', (e) => {
      if (finished) return;
      if (RESOURCE_ERROR_CODES.has(e && e.code)) { degrade(e); return; }
      // Dead for a NON-resource reason: a healthy restart beats a silently
      // half-alive watcher.
      stopAll();
      diag(`watcher error: ${e && e.message ? e.message : e}`);
      exit(1);
    });
  }

  // The sweep: its own timer. Every tick rebuilds the (path,mtime,size) set
  // (diagnosed on divergence) and runs a guarded full signature check.
  const sweepTick = () => {
    if (finished) return;
    let set = null;
    try { set = sweepStatSet(memoriesDir); } catch { /* keep previous */ }
    if (set !== null) {
      if (lastSweepSet !== null && set !== lastSweepSet) diag('sweep: stat set diverged since last scan');
      lastSweepSet = set;
    }
    return coalescer.request('sweep');
  };
  const sweepTimer = setInterval(sweepTick, sweepIntervalMs);
  timers.push(sweepTimer);

  // Idle timeout: on any detection the process exits, so process age IS idle
  // time — one fixed timer from arm, never reset.
  const idleTimer = setTimeout(() => {
    finish({ event: 'idle-timeout', waited_ms: timeoutMs, observed_at: now().toISOString() }, 2);
  }, timeoutMs);
  timers.push(idleTimer);

  // Publish-budget deferral: one timer at retry_at runs the deferred
  // comparison the moment the window reopens — never a busy loop.
  if (retryAtMs !== null && retryAtMs > Date.now()) {
    const retryTimer = setTimeout(() => { if (!finished) coalescer.request('sweep'); }, retryAtMs - Date.now());
    timers.push(retryTimer);
  }

  // Orphan self-check (see header): parent gone → one "orphaned" line, exit 4.
  if (parentPid !== null) {
    // The ppid-drift signal (POSIX reparents an orphan to init) only means
    // something when the watched owner IS our OS parent at arm.
    const ppidTracksParent = typeof process.ppid === 'number' && process.ppid === parentPid;
    const orphanCheck = () => {
      if (finished) return;
      let gone = false;
      try { process.kill(parentPid, 0); } catch { gone = true; }
      if (!gone && ppidTracksParent && process.ppid !== parentPid) gone = true;
      if (gone) finish({ event: 'orphaned', parent_pid: parentPid, observed_at: now().toISOString() }, 4);
    };
    const orphanTimer = setInterval(orphanCheck, ORPHAN_CHECK_INTERVAL_MS);
    timers.push(orphanTimer);
    orphanCheck();
    if (finished) return null;
  }

  // Baseline the sweep set, then run the initial check (ordering contract above).
  try { lastSweepSet = sweepStatSet(memoriesDir); } catch { /* first tick will retry */ }
  const armed = coalescer.request('sweep').then(() => {
    if (!finished) diag(`armed on ${memoriesDir} (debounce ${debounceMs}ms, sweep ${sweepIntervalMs}ms, idle timeout ${timeoutMs}ms)`);
  });

  return {
    armed,
    sweepTick,                 // exported surface for direct sweep testing
    notify: () => coalescer.notify('watch'),
    stop: (signal) => finish({ event: 'stopped', signal, observed_at: now().toISOString() }, 3),
    _stopQuiet: stopAll,       // test teardown without emitting
  };
}

// Whole-token integer validation, shared by EVERY integer flag in both parser
// modes: Number('1ms') is NaN and Number('1.5') is not an integer — parseInt
// would silently accept both as 1.
const takeInt = (flag, v, min = 1) => {
  const n = Number(v);
  const label = min === 0 ? 'a non-negative integer' : 'a positive integer';
  if (typeof v !== 'string' || v.trim() === '' || !Number.isInteger(n) || n < min) {
    throw new Error(`${flag} requires ${label}, got ${JSON.stringify(v)}`);
  }
  return n;
};

export function parseArgs(argv) {
  const opts = {
    projectDir: null,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    baselineSnapshot: null,
    scope: null,
    liveStatePath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debounce-ms') opts.debounceMs = takeInt(a, argv[++i]);
    else if (a === '--sweep-interval-ms') opts.sweepIntervalMs = takeInt(a, argv[++i]);
    else if (a === '--timeout-ms') opts.timeoutMs = takeInt(a, argv[++i]);
    else if (a === '--baseline-snapshot') {
      const v = argv[++i];
      if (!v) throw new Error('--baseline-snapshot requires a value');
      opts.baselineSnapshot = v;
    } else if (a === '--scope') {
      const v = argv[++i];
      if (!WATCH_SCOPES.includes(v)) throw new Error(`--scope must be one of ${WATCH_SCOPES.join(', ')}, got ${JSON.stringify(v)}`);
      opts.scope = v;
    } else if (a === '--live-state') {
      const v = argv[++i];
      if (!v) throw new Error('--live-state requires a path');
      opts.liveStatePath = v;
    } else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (opts.projectDir === null) opts.projectDir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.projectDir) throw new Error('usage: node memory-view-watch.mjs <project> [--debounce-ms N] [--sweep-interval-ms N] [--baseline-snapshot <id>] [--timeout-ms N] [--scope active|all-including-archive] [--live-state <path>]');
  return opts;
}

export function parseWriteLiveStateArgs(argv) {
  const opts = {
    path: null, artifactUrl: null, scope: null, excludeTopics: [],
    baselineSnapshot: null, publishCount: 0, windowStart: null, retryAt: null,
    grantBasis: null,
  };
  const take = (flag, v) => {
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write-live-state') opts.path = take(a, argv[++i]);
    else if (a === '--artifact-url') opts.artifactUrl = take(a, argv[++i]);
    else if (a === '--scope') opts.scope = take(a, argv[++i]);
    else if (a === '--exclude-topic') opts.excludeTopics.push(take(a, argv[++i]));
    else if (a === '--baseline-snapshot') opts.baselineSnapshot = take(a, argv[++i]);
    else if (a === '--window-start') opts.windowStart = take(a, argv[++i]);
    else if (a === '--retry-at') opts.retryAt = take(a, argv[++i]);
    else if (a === '--grant-basis') opts.grantBasis = take(a, argv[++i]);
    else if (a === '--publish-count') opts.publishCount = takeInt(a, argv[++i], 0);
    else throw new Error(`unknown flag ${a} in --write-live-state mode`);
  }
  if (!opts.path) throw new Error('--write-live-state requires a path');
  return opts;
}

// CLI failure paths use SYNCHRONOUS stderr (fs.writeSync) and process.exitCode
// with a natural exit, never process.exit after an async stream write:
// process.stderr.write to a PIPE is asynchronous and an immediate exit can
// truncate it — the refusal must always land on the supervisor's pipe.
function runMain(argv) {
  const fail = (msg) => {
    try { writeSync(2, `memory-view-watch: ${msg}\n`); } catch { /* stderr gone */ }
    process.exitCode = 1;
  };
  if (argv.includes('--write-live-state')) {
    try {
      const w = parseWriteLiveStateArgs(argv);
      const record = writeLiveState(w.path, w);
      writeSync(1, JSON.stringify(record, null, 2) + '\n');
    } catch (e) {
      fail(e.message);
    }
    return; // nothing pending — natural exit carries exitCode
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    fail(e.message);
    return;
  }
  let retryAtMs = null;
  let excludeTopics = [];
  if (opts.liveStatePath) {
    // An EXPLICITLY named record the watcher cannot honor is a config error:
    // arming with defaults instead would reset scope/baseline and can lose a
    // deferred publish. Refuse (exit 1), no protocol line.
    const st = readLiveState(opts.liveStatePath);
    try {
      if (st === null) throw new Error(`--live-state ${opts.liveStatePath} is missing or unreadable`);
      assertLiveState(st);
    } catch (e) {
      fail(`refusing to arm: ${e.message}`);
      return;
    }
    // Explicit CLI flags win; the record fills what the caller left unset.
    if (opts.baselineSnapshot === null) opts.baselineSnapshot = st.baseline_snapshot;
    if (opts.scope === null) opts.scope = st.scope;
    excludeTopics = st.excluded_topics;
    if (st.retry_at) retryAtMs = Date.parse(st.retry_at);
  }
  const handle = startWatcher({ ...opts, excludeTopics, retryAtMs, parentPid: process.ppid });
  if (handle) {
    // Clean stop door. On Windows these handlers may not run — process.kill
    // terminates without signal delivery there; the supervising loop treats
    // any non-0/2 exit as "watcher gone, re-arm or stop" either way.
    process.on('SIGTERM', () => handle.stop('SIGTERM'));
    process.on('SIGINT', () => handle.stop('SIGINT'));
  }
}
if (isCliEntry(import.meta.url)) runMain(process.argv.slice(2));
