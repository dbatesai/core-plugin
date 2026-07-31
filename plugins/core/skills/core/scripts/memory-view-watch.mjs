/**
 * memory-view-watch.mjs — change DETECTOR for the /memory-view live loop.
 *
 * A detector, not a publisher: it never renders, never publishes, never calls
 * any artifact surface, and NEVER WRITES into the store (its snapshot reads go
 * through the renderer's collectUnits with the derived-cache refresh disabled,
 * so even the index cache is untouched). Its whole job is: notice that the
 * store's SCOPED content identity no longer matches the last published
 * snapshot id, say so once on stdout, and exit. The supervising agent handles
 * the change (render → republish → --record-publish) and re-arms a fresh
 * watcher with the new baseline. Exit-on-detect is deliberate — the process
 * lifecycle is trivially clean (no orphan possible beyond one process), and
 * the EXIT of the harness background task is what actually reaches the
 * supervising agent (a background process printing to stdout wakes nobody
 * mid-run; the skill documents the real wake door).
 *
 * CLI (arm mode):
 *   node memory-view-watch.mjs <project> [--debounce-ms 250]
 *        [--sweep-interval-ms 300000] [--baseline-snapshot <id>]
 *        [--timeout-ms 14400000] [--scope active|all-including-archive]
 *        [--live-state <path>]
 * CLI (loop-state write mode — composes and atomically replaces the record):
 *   node memory-view-watch.mjs --write-live-state <path>
 *        --artifact-url <url> --scope <scope> --baseline-snapshot <id>
 *        [--exclude-topic <t>]... [--publish-count N] [--window-start ISO]
 *        [--retry-at ISO] [--grant-basis <text>]
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
 * Consumers dispatch on `event`, never on line position. Usage/config errors
 * exit 1. Diagnostics go to stderr, never stdout. If the ONE terminal emit
 * itself fails (EPIPE — the wake pipe died under the line), the failure is
 * diagnosed on stderr and the process exits 1: exit 0 always means "the
 * store-changed line landed", never "I tried".
 *
 * Orphan self-check: session teardown of a background child is NOT
 * guaranteed by any platform here, so the watcher checks its own parent
 * (cheap signal-0 probe + POSIX reparent detection) every 50ms and, the
 * moment the parent is gone, emits one "orphaned" line and exits 4 — a
 * shell-orphaned watcher shuts itself down within ~a second instead of
 * outliving a dead session. The arm-time baseline comparison of the NEXT
 * live start covers anything that changed in between.
 *
 * Scoped identity — the comparability contract: the watcher compares the
 * EXACT id the renderer receipts for the armed scope, via the ONE canonical
 * producer (collectUnits). active scope → the store snapshot id
 * (sha256(source_sig|enrichment:digest)); all-including-archive → that id
 * extended over the supplemental (archive/ + terminal-status) bytes the page
 * embeds, so an archive-only edit changes an archive-including view's
 * identity and never an active view's. Never compare a raw signature to a
 * receipt id, and never compare across scopes: with --scope (or a
 * --live-state record, which carries the scope) the scope is explicit; with
 * only --baseline-snapshot the first check matches the baseline against both
 * canonical ids and locks the scope the baseline actually came from.
 *
 * Resource exhaustion DEGRADES, never kills: fs.watch failing to arm — or
 * dying later — with EMFILE/ENFILE/ENOSPC drops the process to sweep-only
 * mode: one "degraded" status line, watch handle closed, and the
 * ALREADY-INDEPENDENT sweep keeps detecting. In degraded mode the sweep
 * interval IS the detection-latency SLO (default 5 min, vs ~1s on a healthy
 * event path) — the honest cost of staying alive under a 256-fd ceiling
 * instead of entering a supervisor fail/restart loop. Any OTHER watch error
 * still exits 1: when resources are not the problem, a healthy restart beats
 * a silently half-alive watcher.
 *
 * Design rules, each grounded in this-machine measurements
 * (CORE/dev scratchpad research-viewer-patterns.md §2):
 *  - ONE fs.watch on the DIRECTORY, {recursive:true} — never per-file. A
 *    per-file watcher goes permanently deaf after the store's own atomic
 *    tmp+rename write orphans the watched inode (reproduced), and 550
 *    per-file watchers exceed the 256-fd soft limit under GUI launch.
 *  - eventType is NEVER branched on — macOS reports everything as 'rename'
 *    and the Node docs say the value is unreliable. An event means
 *    "something may have changed, go check", nothing more. The filename is a
 *    hint only (may be null); a null filename still counts as a hint.
 *  - Trailing debounce (default 250ms) + in-flight guard + dirty flag: a
 *    burst of N writes coalesces to one check after the burst settles; a
 *    write landing mid-check queues exactly one more check, never lost.
 *  - Name filter before an event counts: `\.tmp$`, dotfile segments, `~$`,
 *    and anything under `_lib/` are ignored. The store's own writer
 *    (fs-atomic.mjs) emits sibling `.name.tmp-*` dotfiles — without the
 *    filter every logical write triggers extra checks; with it, junk events
 *    never cost a store read. The content-derived snapshot id stays the
 *    single arbiter of "changed", so over-filtering here can only delay
 *    detection to the sweep, never fabricate or lose a change.
 *  - A periodic mtime sweep (default 5 min) is REQUIRED recovery, not
 *    optional hardening: libuv discards FSEvents'
 *    kFSEventStreamEventFlagMustScanSubDirs ("events dropped, rescan"), so
 *    fs.watch can go silently deaf with no error and no event. The sweep is
 *    its own timer walking readdir+stat into a (path,mtime,size) set AND
 *    recomputing the content signature — it never depends on fs.watch
 *    delivery. It is also the degraded-mode detection path (above).
 *  - The watch callback is trivial (flag + timer). A slow callback is what
 *    causes the FSEvents buffer overflow the sweep recovers from.
 *
 * Live-loop state: ONE small JSON record (kind LIVE_STATE_KIND) owned by the
 * supervising loop — artifact_url, scope, excluded_topics, baseline_snapshot,
 * publish_budget {window_start, count}, retry_at. The watcher only READS it
 * (--live-state) for baseline/scope/retry_at; --write-live-state composes and
 * atomically replaces the whole record, so the loop's scope and exclusions
 * survive every hop on disk instead of living in conversation memory.
 * retry_at is the publish-budget deferral door: while it lies in the future
 * the watcher holds every comparison (no emission, no busy-loop against a
 * deliberately-stale baseline), then runs one comparison the moment it
 * passes.
 *
 * The script ships with the plugin by convention. The plugin ships .mjs only.
 */

import { watch as fsWatch, readdirSync, statSync, existsSync, writeSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectUnits } from './render-browse-artifact.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const DEFAULT_DEBOUNCE_MS = 250;
export const DEFAULT_SWEEP_INTERVAL_MS = 300000; // 5 min
export const DEFAULT_TIMEOUT_MS = 14400000;      // 4 h idle
export const ORPHAN_CHECK_INTERVAL_MS = 50;      // getppid/kill-0 is a cheap syscall

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
 * Ignored: any path with a dotfile segment, a `_lib` segment, or a final
 * segment matching IGNORED_BASENAME. A null/undefined filename (fs.watch may
 * legally deliver one) is NOT ignored — it's an unfilterable hint, so it
 * counts. Windows separators normalized.
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
 * sweepStatSet — the recovery scan. Recursive readdir+stat over _memories/
 * building a sorted `path:mtimeMs:size` signature string (ignored names and
 * `_lib/` excluded, matching the event filter). Pure read; independent of
 * fs.watch entirely — this is what still sees a change after FSEvents drops
 * events. Exported for direct testing.
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
 * computeCurrentSnapshot — the store's current identity FOR A SCOPE, derived
 * by the SAME producer the renderer receipts (collectUnits — one canonical
 * snapshot producer, no third watcher identity), read-only (the derived
 * cache refresh stays off inside collectUnits). activeSnapshotId always
 * rides along so a caller holding an unlabeled baseline can match it against
 * both canonical ids and lock the right scope.
 */
export function computeCurrentSnapshot(projectDir, { scope = 'active' } = {}) {
  const c = collectUnits(projectDir, { scope });
  return {
    snapshotId: c.snapshotId,
    activeSnapshotId: c.activeSnapshotId,
    unitsSeen: c.units.length,
    activeUnitsSeen: c.units.filter((u) => u.population === 'active').length,
  };
}

/**
 * createCoalescer — trailing debounce + in-flight guard + dirty flag
 * (research §2.3 pseudocode, verbatim semantics):
 *   on event  → mark dirty; restart the trailing timer
 *   maybeRun  → if a check is in flight, return (the flag survives);
 *               otherwise clear the flag, run the check, and if a change
 *               landed mid-check (flag set again) run EXACTLY ONE follow-up.
 * Without the dirty flag, a file saved during a check is silently lost until
 * the next unrelated event. Exported for direct (deterministic) testing.
 */
export function createCoalescer({ debounceMs, check, onError = () => {} }) {
  let timer = null;
  let dirty = false;
  let running = false;

  async function maybeRun(trigger) {
    if (running) return;
    // Every trigger sets the dirty flag first, so a clear flag here means a
    // STALE debounce timer (its pending work was already consumed by the
    // post-check follow-up). Running anyway would make "a mid-check change
    // queues exactly one more check" false — it would queue two.
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
    // sweep path: immediate but guarded — never overlaps a running check;
    // if one is in flight the dirty flag forces the follow-up instead.
    request(trigger) {
      dirty = true;
      return maybeRun(trigger);
    },
    stop() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

/**
 * readLiveState — best-effort read of the loop-state record. Absent,
 * unparsable, or non-object → null (the caller arms without it and says so
 * on stderr; a corrupt record must never crash the detector).
 */
export function readLiveState(path) {
  try {
    const st = JSON.parse(readFileSync(path, 'utf8'));
    return st && typeof st === 'object' && !Array.isArray(st) ? st : null;
  } catch { return null; }
}

/**
 * writeLiveState — compose and ATOMICALLY replace the whole loop-state
 * record (sibling-tmp + rename via fs-atomic.mjs; a reader never sees a
 * half-written record). Whole-record replace, no merge: the supervisor
 * re-states scope/exclusions/baseline on every write, which is exactly what
 * makes a refresh unable to silently drop them. Returns the record written.
 */
export function writeLiveState(path, {
  artifactUrl, scope, excludeTopics = [], baselineSnapshot,
  publishCount = 0, windowStart = null, retryAt = null,
  grantBasis = null, now = () => new Date(),
} = {}) {
  if (!artifactUrl) throw new Error('--write-live-state requires --artifact-url');
  if (!WATCH_SCOPES.includes(scope)) throw new Error(`--write-live-state requires --scope ${WATCH_SCOPES.join('|')}`);
  if (!baselineSnapshot) throw new Error('--write-live-state requires --baseline-snapshot');
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
    // exclusions ABOVE — future republishes are authorized only within them.
    // The agent re-checks the boundary at each refresh; the watcher never
    // inspects content.
    grant_basis: grantBasis === null ? null : String(grantBasis),
    baseline_snapshot: String(baselineSnapshot),
    publish_budget: {
      window_start: isoOrNull('--window-start', windowStart) || now().toISOString(),
      count: publishCount,
    },
    retry_at: isoOrNull('--retry-at', retryAt),
    updated_at: now().toISOString(),
  };
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWriteFileSync(abs, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * startWatcher — arm everything and return a handle. All effects are
 * injectable (emit/status/exit/diag/watchFn) so tests can run it in-process
 * and simulate a deaf fs.watch (never fires — the dropped-events failure
 * mode the sweep exists for) or a resource-dead one (EMFILE sync or async —
 * the degraded-mode failure the sweep also covers).
 *
 * Ordering contract: fs.watch is armed BEFORE the initial signature read, so
 * a write landing during that read still produces an event; then ONE initial
 * check runs — with a provided baseline it catches anything that changed
 * between the last publish and this arm (reported as trigger:"sweep", since
 * it is a scan, not an event). That initial same-scoped comparison is the
 * executable recovery for the exit window: a write landing between a
 * previous watcher's detection and its exit is caught HERE, at the next arm,
 * not left waiting for a new event or the five-minute sweep. Without a
 * baseline, the current id becomes the baseline. `armed` resolves after the
 * initial check.
 */
export function startWatcher({
  projectDir,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baselineSnapshot = null,
  scope = null,      // explicit scope; null → locked from the baseline at the first check
  retryAtMs = null,  // publish-budget deferral: hold every comparison until this epoch-ms
  parentPid = null,  // owner process to outlive-check (CLI passes process.ppid); null → no check
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
    // The one terminal line IS the wake contract: if it cannot land (EPIPE —
    // the consumer side of stdout died under us), exiting with the normal
    // code would make exit 0 ambiguous. Diagnose and exit 1 instead.
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

  // The check: recompute the store's SCOPED snapshot id; if it no longer
  // matches the baseline, report once and finish. The id is content-derived,
  // so a check triggered by junk (or by nothing) can never emit a false
  // change — and it is scope-derived, so it is always comparable to the
  // baseline it was armed with.
  async function check(trigger) {
    if (finished) return;
    // Publish-budget deferral: while retry_at lies ahead, compare nothing —
    // a re-arm over a deliberately-stale baseline must not busy-loop. The
    // retry timer below runs one check the moment retry_at passes.
    if (retryAtMs !== null && Date.now() < retryAtMs) return;
    // Yield once so any fs events already queued behind a burst are delivered
    // (and can set the dirty flag) before this read starts.
    await new Promise((r) => setImmediate(r));
    if (finished) return;
    if (lockedScope === null) {
      // Unlabeled baseline: match it against BOTH canonical scoped ids and
      // lock the scope it actually came from. Comparing a raw signature — or
      // a differently-scoped id — to a receipt id would report "changed"
      // forever (the incomparable-identity defect).
      const cur = computeCurrentSnapshot(root, { scope: 'all-including-archive' });
      if (baseline === null) { baseline = cur.activeSnapshotId; lockedScope = 'active'; return; }
      if (cur.snapshotId === baseline) { lockedScope = 'all-including-archive'; return; }
      lockedScope = 'active';
      if (cur.activeSnapshotId !== baseline) changed(cur.activeSnapshotId, cur.activeUnitsSeen, trigger);
      return;
    }
    const cur = computeCurrentSnapshot(root, { scope: lockedScope });
    if (baseline === null) { baseline = cur.snapshotId; return; } // first arm, no baseline given
    if (cur.snapshotId !== baseline) changed(cur.snapshotId, cur.unitsSeen, trigger);
  }

  const coalescer = createCoalescer({
    debounceMs,
    check,
    onError: (e) => diag(`check failed: ${e && e.message ? e.message : e}`),
  });

  // Resource exhaustion → sweep-only mode: close the (possibly dead) watch
  // handle, say so ONCE on stdout as a status line (not an exit), and let the
  // already-independent sweep carry detection. The degraded SLO is the sweep
  // interval; the supervising loop re-arms a healthy watcher on next wake.
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

  // ONE recursive directory watch. The callback is deliberately trivial:
  // filter, flag, timer — never any I/O (a slow callback is what overflows
  // the FSEvents buffer). eventType is ignored on principle.
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
      // A watcher dead for a NON-resource reason must not silently degrade:
      // the supervising loop should restart a healthy process instead.
      stopAll();
      diag(`watcher error: ${e && e.message ? e.message : e}`);
      exit(1);
    });
  }

  // The sweep: its own timer, never a re-trigger of fs.watch. Every tick
  // rebuilds the (path,mtime,size) set (diagnosed on divergence) and runs a
  // guarded full signature check — recovery does not depend on the set's
  // mtime granularity, the content hash is always recomputed.
  const sweepTick = () => {
    if (finished) return;
    let set = null;
    try { set = sweepStatSet(memoriesDir); } catch { /* keep previous */ }
    if (set !== null) {
      if (lastSweepSet !== null && set !== lastSweepSet) diag('sweep: stat set diverged since last scan');
      lastSweepSet = set;
    }
    coalescer.request('sweep');
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
  // comparison the moment the window reopens (the check() gate holds
  // everything before then) — never a busy loop, never a lost change.
  if (retryAtMs !== null && retryAtMs > Date.now()) {
    const retryTimer = setTimeout(() => { if (!finished) coalescer.request('sweep'); }, retryAtMs - Date.now());
    timers.push(retryTimer);
  }

  // Orphan self-check: no platform here guarantees a background child dies
  // with its session, so the watcher owns its own lifecycle — parent gone
  // (signal-0 probe fails, or POSIX reparented us away from it) → one
  // "orphaned" line, exit 4. Checked immediately and then every 50ms; an
  // orphan lives well under a second past its owner.
  if (parentPid !== null) {
    // The ppid-drift signal (POSIX reparents an orphan to init) only means
    // something when the watched owner IS our OS parent at arm — a
    // supervisor passing some other process's pid still gets the signal-0
    // probe, just not the drift heuristic.
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

  // Baseline the sweep set, then run the initial check (see ordering contract).
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
  const takeInt = (flag, v) => {
    // Whole-token validation: Number('1ms') is NaN and Number('1.5') is not
    // an integer — parseInt would silently accept both as 1.
    const n = Number(v);
    if (typeof v !== 'string' || v.trim() === '' || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} requires a positive integer, got ${JSON.stringify(v)}`);
    }
    return n;
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
    else if (a === '--publish-count') {
      const n = Number.parseInt(take(a, argv[++i]), 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--publish-count requires a non-negative integer`);
      opts.publishCount = n;
    } else throw new Error(`unknown flag ${a} in --write-live-state mode`);
  }
  if (!opts.path) throw new Error('--write-live-state requires a path');
  return opts;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--write-live-state')) {
    try {
      const w = parseWriteLiveStateArgs(argv);
      const record = writeLiveState(w.path, w);
      process.stdout.write(JSON.stringify(record, null, 2) + '\n');
      process.exit(0);
    } catch (e) {
      process.stderr.write(`memory-view-watch: ${e.message}\n`);
      process.exit(1);
    }
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`memory-view-watch: ${e.message}\n`);
    process.exit(1);
  }
  let retryAtMs = null;
  if (opts.liveStatePath) {
    const st = readLiveState(opts.liveStatePath);
    if (st) {
      // Explicit CLI flags win; the record fills what the caller left unset.
      if (opts.baselineSnapshot === null && typeof st.baseline_snapshot === 'string') opts.baselineSnapshot = st.baseline_snapshot;
      if (opts.scope === null && WATCH_SCOPES.includes(st.scope)) opts.scope = st.scope;
      if (st.retry_at) {
        const t = Date.parse(st.retry_at);
        if (Number.isFinite(t)) retryAtMs = t;
      }
    } else {
      process.stderr.write(`memory-view-watch: --live-state ${opts.liveStatePath} missing or unreadable — arming without it\n`);
    }
  }
  const handle = startWatcher({ ...opts, retryAtMs, parentPid: process.ppid });
  if (handle) {
    // Clean stop door. On Windows these handlers may not run — process.kill
    // terminates without signal delivery there; the supervising loop treats
    // any non-0/2 exit as "watcher gone, re-arm or stop" either way.
    process.on('SIGTERM', () => handle.stop('SIGTERM'));
    process.on('SIGINT', () => handle.stop('SIGINT'));
  }
}
