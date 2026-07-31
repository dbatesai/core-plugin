/**
 * memory-view-watch.mjs — change DETECTOR for the /memory-view live loop.
 *
 * A detector, not a publisher: it never renders, never publishes, never calls
 * any artifact surface, and NEVER WRITES into the store (its snapshot reads go
 * through loadSnapshot with refreshCache:false, so even the derived index
 * cache is untouched). Its whole job is: notice that the store's content
 * signature no longer matches the last published snapshot id, say so once on
 * stdout, and exit. The supervising agent handles the change (render →
 * republish → --record-publish) and re-arms a fresh watcher with the new
 * baseline. Exit-on-detect is deliberate — the process lifecycle is trivially
 * clean (no orphan possible beyond one process) and the exit IS the wake
 * mechanism.
 *
 * CLI:
 *   node memory-view-watch.mjs <project> [--debounce-ms 250]
 *        [--sweep-interval-ms 300000] [--baseline-snapshot <id>]
 *        [--timeout-ms 14400000]
 *
 * stdout protocol (one JSON line per lifecycle outcome, then exit):
 *   {"event":"store-changed","snapshot_id":"…","units_seen":N,
 *    "trigger":"watch|sweep","observed_at":"ISO"}            → exit 0
 *   {"event":"idle-timeout","waited_ms":N,"observed_at":"ISO"} → exit 2
 *   {"event":"stopped","signal":"SIGTERM|SIGINT","observed_at":"ISO"} → exit 3
 * Usage/config errors exit 1. Diagnostics go to stderr, never stdout.
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
 *    delivery.
 *  - The watch callback is trivial (flag + timer). A slow callback is what
 *    causes the FSEvents buffer overflow the sweep recovers from.
 *
 * Snapshot identity: the exact id the renderer receipts —
 * loadSnapshot(project, {captureBodies:true}) → captureStore →
 * sha256(source_sig|enrichment:digest). Computing it any other way (e.g. a
 * bare hash of computeSourceSignature()) would never equal a receipted
 * baseline and the loop would republish forever.
 *
 * The script ships with the plugin by convention. The plugin ships .mjs only.
 */

import { watch as fsWatch, readdirSync, statSync, existsSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSnapshot } from './generate-summary-index.mjs';

export const DEFAULT_DEBOUNCE_MS = 250;
export const DEFAULT_SWEEP_INTERVAL_MS = 300000; // 5 min
export const DEFAULT_TIMEOUT_MS = 14400000;      // 4 h idle

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
 * computeCurrentSnapshot — the store's current identity, derived exactly the
 * way the renderer derives the id it receipts (same helper, same options,
 * minus any cache write). Reads every candidate file once; never writes.
 */
export function computeCurrentSnapshot(projectDir) {
  const snap = loadSnapshot(projectDir, { captureBodies: true, refreshCache: false });
  return { snapshotId: snap.snapshotId, unitsSeen: snap.index.units.length };
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
 * startWatcher — arm everything and return a handle. All effects are
 * injectable (emit/exit/diag/watchFn) so tests can run it in-process and
 * simulate a deaf fs.watch (watchFn returning a watcher that never fires —
 * exactly the dropped-events failure mode the sweep exists for).
 *
 * Ordering contract: fs.watch is armed BEFORE the initial signature read, so
 * a write landing during that read still produces an event; then ONE initial
 * check runs — with a provided baseline it catches anything that changed
 * between the last publish and this arm (reported as trigger:"sweep", since
 * it is a scan, not an event); without one, the current id becomes the
 * baseline. `armed` on the handle resolves after the initial check.
 */
export function startWatcher({
  projectDir,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baselineSnapshot = null,
  emit = (obj) => writeSync(1, JSON.stringify(obj) + '\n'),
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
  let lastSweepSet = null;
  let finished = false;
  const timers = [];

  const stopAll = () => {
    finished = true;
    coalescer.stop();
    for (const t of timers) clearTimeout(t);
    try { watcher.close(); } catch { /* already closed */ }
  };

  const finish = (obj, code) => {
    if (finished) return;
    stopAll();
    emit(obj);
    exit(code);
  };

  // The check: recompute the store's snapshot id; if it no longer matches the
  // baseline, report once and finish. The id is content-derived, so a check
  // triggered by junk (or by nothing) can never emit a false change.
  async function check(trigger) {
    if (finished) return;
    // Yield once so any fs events already queued behind a burst are delivered
    // (and can set the dirty flag) before this read starts.
    await new Promise((r) => setImmediate(r));
    if (finished) return;
    const { snapshotId, unitsSeen } = computeCurrentSnapshot(root);
    if (baseline === null) { baseline = snapshotId; return; } // first arm, no --baseline-snapshot
    if (snapshotId !== baseline) {
      finish({
        event: 'store-changed',
        snapshot_id: snapshotId,
        units_seen: unitsSeen,
        trigger,
        observed_at: now().toISOString(),
      }, 0);
    }
  }

  const coalescer = createCoalescer({
    debounceMs,
    check,
    onError: (e) => diag(`check failed: ${e && e.message ? e.message : e}`),
  });

  // ONE recursive directory watch. The callback is deliberately trivial:
  // filter, flag, timer — never any I/O (a slow callback is what overflows
  // the FSEvents buffer). eventType is ignored on principle.
  let watcher;
  try {
    watcher = watchFn(memoriesDir, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnoreRel(filename)) return;
      coalescer.notify('watch');
    });
  } catch (e) {
    diag(`fs.watch failed: ${e && e.message ? e.message : e}`);
    exit(1);
    return null;
  }
  watcher.on('error', (e) => {
    // A dead watcher must not silently degrade into sweep-only mode: the
    // supervising loop should restart a healthy process instead.
    if (finished) return;
    stopAll();
    diag(`watcher error: ${e && e.message ? e.message : e}`);
    exit(1);
  });

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
  };
  const takeInt = (flag, v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} requires a positive integer, got ${JSON.stringify(v)}`);
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
    } else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (opts.projectDir === null) opts.projectDir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.projectDir) throw new Error('usage: node memory-view-watch.mjs <project> [--debounce-ms N] [--sweep-interval-ms N] [--baseline-snapshot <id>] [--timeout-ms N]');
  return opts;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`memory-view-watch: ${e.message}\n`);
    process.exit(1);
  }
  const handle = startWatcher(opts);
  if (handle) {
    // Clean stop door. On Windows these handlers may not run — process.kill
    // terminates without signal delivery there; the supervising loop treats
    // any non-0/2 exit as "watcher gone, re-arm or stop" either way.
    process.on('SIGTERM', () => handle.stop('SIGTERM'));
    process.on('SIGINT', () => handle.stop('SIGINT'));
  }
}
