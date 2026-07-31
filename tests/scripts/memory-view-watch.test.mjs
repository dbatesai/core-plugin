/**
 * memory-view-watch.mjs — the /memory-view live-loop change detector.
 *
 * Every store here is a throwaway temp-dir fixture; nothing touches a real
 * `_memories/` store or real `~/.core`. Child-process tests run the script
 * exactly as the skill does; in-process tests inject a deaf fs.watch (a
 * watcher that never fires — the exact silently-dropped-FSEvents failure
 * mode) to prove the sweep is a real recovery path, and drive the coalescer
 * with explicit gates to prove the dirty flag deterministically.
 *
 * Non-vacuity anchors (each verified red by mutation during development):
 *  - burst test asserts the emitted snapshot_id equals the FINAL store
 *    state's id — a leading-edge (non-trailing) debounce emits an
 *    intermediate id and fails;
 *  - dotfile test plants `.hidden.md`, which IS signature-relevant content
 *    (isCandidateName admits dotfiles ending .md) — remove the event filter
 *    and the watch path emits, turning "no output" red;
 *  - deaf-watcher test removes event delivery entirely — remove the sweep
 *    timer and nothing ever detects the mutation;
 *  - the `_lib/unit-summaries.json` absence assertions prove the watcher's
 *    reads are side-effect free (refreshCache:false) — drop that option and
 *    the cache file appears.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
  watch as fsWatchReal, openSync, closeSync, readFileSync, readdirSync, chmodSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const WATCH = join(SCRIPTS, 'memory-view-watch.mjs');

const {
  startWatcher, createCoalescer, sweepStatSet, shouldIgnoreRel,
  computeCurrentSnapshot, parseArgs, parseWriteLiveStateArgs,
  readLiveState, writeLiveState, LIVE_STATE_KIND,
} = await import(pathToFileURL(WATCH).href);
const { atomicWriteFileSync } = await import(pathToFileURL(join(SCRIPTS, 'fs-atomic.mjs')).href);

const IS_WIN = process.platform === 'win32';
// Signal-delivery tests: child.kill('SIGTERM') on Windows terminates without
// running handlers, so the exit-3 contract is untestable there (documented in
// the script header).
const posixTest = (name, fn) => test(name, IS_WIN ? { skip: 'signal delivery unsupported for Windows child processes' } : {}, fn);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await delay(20);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function unitContent(id, body) {
  return `---\nid: ${id}\ntype: decision\nstatus: active\n---\n\n${body}\n`;
}

/** Throwaway fixture: <tmp>/proj/_memories with n plain active units. */
function makeStore(n = 3) {
  const base = mkdtempSync(join(tmpdir(), 'mvw-'));
  const proj = join(base, 'proj');
  mkdirSync(join(proj, '_memories'), { recursive: true });
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(proj, '_memories', `unit-${i}.md`), unitContent(`unit-${i}`, `Body of unit ${i}.`));
  }
  return { base, proj, memories: join(proj, '_memories') };
}

function spawnWatcher(proj, args) {
  const child = spawn(process.execPath, [WATCH, proj, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  let done = false;
  const exited = new Promise((r) => child.on('close', (code, signal) => { done = true; r({ code, signal }); }));
  // Resolves on the armed line OR child exit (so an early exit never leaves a
  // dangling poller); tests that await it and need a live child assert that next.
  const armed = waitFor(() => done || err.includes('armed on'), 10000, 'watcher armed line on stderr');
  armed.catch(() => {});
  return { child, exited, armed, getOut: () => out, getErr: () => err };
}

function stdoutLines(out) {
  return out.split('\n').filter((l) => l.trim() !== '');
}

// TERMINAL protocol lines only: "degraded" and "check-failed" are documented
// non-terminal STATUS lines (the process keeps running after emitting them);
// consumers dispatch on `event`, never on line position — so must the suite.
function protocolLines(out) {
  return stdoutLines(out).filter((l) => {
    try { return !['degraded', 'check-failed'].includes(JSON.parse(l).event); } catch { return true; }
  });
}

// Environment capability probe. Under a low FD ceiling (the reviewer's real
// 256-fd GUI-launch environment) REAL fs.watch can fail with EMFILE — the
// watcher's contract there is DEGRADED sweep-only mode, not death. Where
// fs.watch works, this suite asserts the full watch-path contract (trigger
// "watch", trailing-debounce final-state id, sweep timers parked at 10 min);
// where it does not, the same tests assert the degraded contract (detection
// still happens, via sweep, exit 0). Both branches are exact assertions —
// neither run weakens the other's guarantees, and the forced-EMFILE tests
// further down exercise degraded mode deterministically on EVERY machine.
const WATCH_HEALTHY = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mvw-probe-'));
  try {
    const w = fsWatchReal(dir, { recursive: true }, () => {});
    const healthy = await new Promise((res) => {
      w.on('error', () => res(false));
      setTimeout(() => res(true), 300);
    });
    try { w.close(); } catch { /* closed */ }
    return healthy;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

function assertIso(s) {
  assert.equal(new Date(s).toISOString(), s, `observed_at must be a round-trippable ISO stamp, got ${s}`);
}

// ---------------------------------------------------------------------------
// Burst coalescing — 20 rapid writes, exactly one store-changed line, and the
// reported id is the FINAL store state's id (a leading-edge or per-event
// implementation reports an intermediate id — the mutation that proves this
// test non-vacuous).
test('burst of 20 rapid writes coalesces to exactly one store-changed for the final state', async () => {
  const { base, proj } = makeStore(3);
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    // Healthy fs.watch: sweep parked far away so only the event path can
    // detect. Degraded environment: the sweep IS the detection path, so it
    // runs fast enough to catch the burst within the timeout.
    const w = spawnWatcher(proj, ['--debounce-ms', '250', '--sweep-interval-ms', WATCH_HEALTHY ? '600000' : '500', '--timeout-ms', '30000', '--baseline-snapshot', baseline]);
    await w.armed;

    for (let i = 0; i < 20; i++) {
      const file = `unit-${(i % 3) + 1}.md`;
      writeFileSync(join(proj, '_memories', file), unitContent(file.replace(/\.md$/, ''), `Burst revision ${i}.`));
      await delay(10); // spread the burst so a leading-edge check would see an intermediate state
    }
    const expected = computeCurrentSnapshot(proj); // final state, after all 20 writes

    const { code } = await w.exited;
    assert.equal(code, 0, `expected change-detected exit 0, stderr: ${w.getErr()}`);
    const lines = protocolLines(w.getOut());
    assert.equal(lines.length, 1, `exactly one terminal protocol line, got: ${JSON.stringify(lines)}`);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'store-changed');
    if (WATCH_HEALTHY) {
      assert.equal(ev.trigger, 'watch');
      assert.equal(ev.snapshot_id, expected.snapshotId, 'must report the post-burst FINAL snapshot id — trailing debounce');
      assert.equal(ev.units_seen, expected.unitsSeen);
    } else {
      // Degraded (sweep-only) mode makes no coalescing promise — a sweep may
      // legitimately catch a mid-burst state; the contract is that a change
      // IS detected and reported with a real (non-baseline) id.
      assert.equal(ev.trigger, 'sweep', 'no event path exists in a degraded environment');
      assert.notEqual(ev.snapshot_id, baseline, 'the reported id must reflect a real change');
    }
    assertIso(ev.observed_at);
    // The detector never writes into the store — not even the derived cache.
    assert.ok(!existsSync(join(proj, '_memories', '_lib', 'unit-summaries.json')),
      'watcher reads must be side-effect free (refreshCache:false)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Atomic-write pattern — the store's REAL writer shape (fs-atomic.mjs sibling
// dotfile tmp + rename) is detected exactly once and no tmp name leaks into
// either output stream.
test('atomic tmp+rename write (the store writer shape) detected once; tmp name never in output', async () => {
  const { base, proj } = makeStore(2);
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    const w = spawnWatcher(proj, ['--debounce-ms', '150', '--sweep-interval-ms', WATCH_HEALTHY ? '600000' : '400', '--timeout-ms', '30000', '--baseline-snapshot', baseline]);
    await w.armed;

    atomicWriteFileSync(join(proj, '_memories', 'unit-new.md'), unitContent('unit-new', 'Atomically written unit.'));
    const expected = computeCurrentSnapshot(proj);

    const { code } = await w.exited;
    assert.equal(code, 0, `stderr: ${w.getErr()}`);
    const lines = protocolLines(w.getOut());
    assert.equal(lines.length, 1, `exactly one terminal protocol line, got: ${JSON.stringify(lines)}`);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'store-changed');
    assert.equal(ev.snapshot_id, expected.snapshotId);
    assert.equal(ev.units_seen, expected.unitsSeen);
    assert.ok(!w.getOut().includes('.tmp'), 'tmp names must never appear on stdout');
    assert.ok(!w.getErr().includes('.tmp'), 'tmp names must never appear on stderr');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unchanged store — sweeps tick repeatedly, nothing is emitted, the process
// stays alive, and the store stays untouched.
test('unchanged store emits nothing across many sweep ticks', async () => {
  const { base, proj } = makeStore(3);
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    const w = spawnWatcher(proj, ['--debounce-ms', '100', '--sweep-interval-ms', '200', '--timeout-ms', '30000', '--baseline-snapshot', baseline]);
    await w.armed;
    await delay(1200); // ~5-6 sweep ticks, each recomputing the full signature
    assert.deepEqual(protocolLines(w.getOut()), [], 'no event may be emitted for an unchanged store');
    assert.equal(w.child.exitCode, null, 'watcher must still be running');
    assert.ok(!existsSync(join(proj, '_memories', '_lib', 'unit-summaries.json')),
      'sweep checks must not write the derived cache');
    w.child.kill('SIGTERM');
    const { code } = await w.exited;
    if (!IS_WIN) assert.equal(code, 3, 'clean signal exit');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sweep recovery — fs.watch is replaced with a DEAF watcher (never fires),
// simulating the libuv-discarded "events dropped, rescan" state. Only the
// sweep timer can notice the mutation. Remove the sweep and this test is red.
test('deaf fs.watch: a mutation is still detected, via sweep, with trigger:"sweep"', async () => {
  const { base, proj } = makeStore(3);
  const events = [];
  const codes = [];
  let handle;
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    handle = startWatcher({
      projectDir: proj,
      debounceMs: 50,
      sweepIntervalMs: 120,
      timeoutMs: 60000,
      baselineSnapshot: baseline,
      emit: (e) => events.push(e),
      exit: (c) => codes.push(c),
      diag: () => {},
      watchFn: () => ({ on() {}, close() {} }), // deaf: no event ever delivered
    });
    await handle.armed;
    assert.equal(events.length, 0, 'nothing changed yet');

    writeFileSync(join(proj, '_memories', 'unit-2.md'), unitContent('unit-2', 'Mutated while the watcher was deaf.'));
    const expected = computeCurrentSnapshot(proj);

    await waitFor(() => events.length > 0, 5000, 'sweep-triggered store-changed');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'store-changed');
    assert.equal(events[0].trigger, 'sweep', 'only the sweep could have seen this');
    assert.equal(events[0].snapshot_id, expected.snapshotId);
    assert.equal(events[0].units_seen, expected.unitsSeen);
    assertIso(events[0].observed_at);
    assert.deepEqual(codes, [0]);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

// The sweep's stat-set primitive, tested directly: real content moves the
// set; ignored shapes (dotfiles, _lib/, tmp, backups) never do.
test('sweepStatSet: (path,mtime,size) set tracks real files and ignores junk shapes', () => {
  const { base, memories } = makeStore(2);
  try {
    const s0 = sweepStatSet(memories);
    assert.ok(s0.includes('unit-1.md:'), 'set carries path:mtime:size entries');

    mkdirSync(join(memories, '_lib'), { recursive: true });
    writeFileSync(join(memories, '_lib', 'junk.json'), '{}');
    writeFileSync(join(memories, '.hidden.md'), unitContent('hidden', 'dot'));
    writeFileSync(join(memories, 'note.md.tmp'), 'partial');
    writeFileSync(join(memories, 'backup.md~'), 'old');
    assert.equal(sweepStatSet(memories), s0, 'junk shapes must not move the sweep set');

    writeFileSync(join(memories, 'unit-3.md'), unitContent('unit-3', 'New real unit.'));
    assert.notEqual(sweepStatSet(memories), s0, 'a real unit write must move the sweep set');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Idle timeout — nothing changes, the watcher exits 2 with the documented
// JSON line.
test('idle timeout exits 2 with the idle-timeout event', async () => {
  const { base, proj } = makeStore(2);
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    const w = spawnWatcher(proj, ['--debounce-ms', '100', '--sweep-interval-ms', '600000', '--timeout-ms', '600', '--baseline-snapshot', baseline]);
    const { code } = await w.exited;
    assert.equal(code, 2, `stderr: ${w.getErr()}`);
    const lines = protocolLines(w.getOut());
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'idle-timeout');
    assert.equal(ev.waited_ms, 600);
    assertIso(ev.observed_at);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Signals — SIGTERM and SIGINT both close the watcher and exit 3.
posixTest('SIGTERM exits 3 cleanly with a stopped event', async () => {
  const { base, proj } = makeStore(2);
  try {
    const w = spawnWatcher(proj, ['--sweep-interval-ms', '600000', '--timeout-ms', '30000']);
    await w.armed;
    w.child.kill('SIGTERM');
    const { code } = await w.exited;
    assert.equal(code, 3, `stderr: ${w.getErr()}`);
    const lines = protocolLines(w.getOut());
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'stopped');
    assert.equal(ev.signal, 'SIGTERM');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

posixTest('SIGINT exits 3 cleanly', async () => {
  const { base, proj } = makeStore(2);
  try {
    const w = spawnWatcher(proj, ['--sweep-interval-ms', '600000', '--timeout-ms', '30000']);
    await w.armed;
    w.child.kill('SIGINT');
    const { code } = await w.exited;
    assert.equal(code, 3, `stderr: ${w.getErr()}`);
    assert.equal(JSON.parse(protocolLines(w.getOut())[0]).signal, 'SIGINT');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Event filter — _lib/, dotfiles, tmp and backup names never trigger the
// watch path. Non-vacuous because `.hidden.md` IS signature-relevant store
// content (isCandidateName admits dotfiles ending in .md): without the event
// filter the watch path computes a CHANGED id and emits — red here.
test('_lib/, dotfile, tmp and backup writes do not trigger the watch path', async () => {
  const { base, proj } = makeStore(2);
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    const w = spawnWatcher(proj, ['--debounce-ms', '80', '--sweep-interval-ms', '600000', '--timeout-ms', '30000', '--baseline-snapshot', baseline]);
    await w.armed;

    mkdirSync(join(proj, '_memories', '_lib'), { recursive: true });
    writeFileSync(join(proj, '_memories', '_lib', 'junk.json'), '{"noise":true}');
    writeFileSync(join(proj, '_memories', '.hidden.md'), unitContent('hidden', 'Signature-relevant dotfile.'));
    writeFileSync(join(proj, '_memories', 'note.md.tmp'), 'half-written');
    writeFileSync(join(proj, '_memories', 'backup.md~'), 'editor backup');
    await delay(800); // several debounce windows past the writes

    assert.deepEqual(protocolLines(w.getOut()), [], 'filtered writes must not produce any event');
    assert.equal(w.child.exitCode, null, 'watcher must still be running');
    w.child.kill(IS_WIN ? undefined : 'SIGTERM');
    await w.exited;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('shouldIgnoreRel: the exact filter table', () => {
  assert.equal(shouldIgnoreRel('unit.md'), false);
  assert.equal(shouldIgnoreRel('observations/2026-07/obs.md'), false);
  assert.equal(shouldIgnoreRel(null), false, 'a null filename is an unfilterable hint and must count');
  assert.equal(shouldIgnoreRel(undefined), false);
  assert.equal(shouldIgnoreRel('unit.md.tmp'), true);
  assert.equal(shouldIgnoreRel('.unit.md.tmp-123-4'), true, 'fs-atomic sibling tmp shape');
  assert.equal(shouldIgnoreRel('.hidden.md'), true);
  assert.equal(shouldIgnoreRel('sub/.hidden.md'), true);
  assert.equal(shouldIgnoreRel('backup.md~'), true);
  assert.equal(shouldIgnoreRel('_lib/unit-summaries.json'), true);
  assert.equal(shouldIgnoreRel('_lib/nested/deep.md'), true);
  assert.equal(shouldIgnoreRel('sub\\win\\unit.md'), false, 'windows separators normalized');
  assert.equal(shouldIgnoreRel('sub\\_lib\\x.json'), true);
});

// ---------------------------------------------------------------------------
// The dirty flag, deterministically: a change landing while a check is in
// flight queues EXACTLY one more check — not zero (naive in-flight guard
// loses it), not two (stale debounce timer double-fires).
test('coalescer: a change landing mid-check queues exactly one more check', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  let firstStarted;
  const started = new Promise((r) => { firstStarted = r; });
  const c = createCoalescer({
    debounceMs: 10,
    check: async () => {
      runs += 1;
      if (runs === 1) { firstStarted(); await gate; }
    },
  });
  c.notify();
  await started;   // first check is now in flight
  c.notify();      // mid-check change
  c.notify();      // and another — still exactly ONE follow-up owed
  await delay(50); // let the 10ms debounce timer fire INTO the in-flight guard
  assert.equal(runs, 1, 'in-flight guard must hold while the first check runs');
  release();
  await delay(60); // follow-up runs; any stale timer must now be a no-op
  assert.equal(runs, 2, 'exactly one follow-up check — the mid-check change is neither lost nor double-counted');
  c.stop();
});

// ---------------------------------------------------------------------------
// Re-arm gap: the store changed BETWEEN the last publish and watcher start —
// the startup scan catches it immediately (trigger "sweep", it is a scan).
test('baseline mismatch at startup is reported immediately', async () => {
  const { base, proj } = makeStore(3);
  try {
    const staleBaseline = computeCurrentSnapshot(proj).snapshotId;
    writeFileSync(join(proj, '_memories', 'unit-1.md'), unitContent('unit-1', 'Changed before the watcher was re-armed.'));
    const expected = computeCurrentSnapshot(proj);

    const w = spawnWatcher(proj, ['--sweep-interval-ms', '600000', '--timeout-ms', '30000', '--baseline-snapshot', staleBaseline]);
    const { code } = await w.exited;
    assert.equal(code, 0, `stderr: ${w.getErr()}`);
    const lines = protocolLines(w.getOut());
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'store-changed');
    assert.equal(ev.trigger, 'sweep');
    assert.equal(ev.snapshot_id, expected.snapshotId);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guard rails: bad invocations fail closed.
test('parseArgs: defaults, overrides, and rejection of malformed invocations', () => {
  const d = parseArgs(['/some/proj']);
  assert.equal(d.projectDir, '/some/proj');
  assert.equal(d.debounceMs, 250);
  assert.equal(d.sweepIntervalMs, 300000);
  assert.equal(d.timeoutMs, 14400000);
  assert.equal(d.baselineSnapshot, null);

  const o = parseArgs(['/p', '--debounce-ms', '100', '--sweep-interval-ms', '5000', '--timeout-ms', '9999', '--baseline-snapshot', 'abc']);
  assert.deepEqual(
    [o.debounceMs, o.sweepIntervalMs, o.timeoutMs, o.baselineSnapshot],
    [100, 5000, 9999, 'abc'],
  );

  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['/p', '--bogus']), /unknown flag/);
  assert.throws(() => parseArgs(['/p', '--debounce-ms', 'soon']), /positive integer/);
  assert.throws(() => parseArgs(['/p', 'extra']), /unexpected argument/);
  // Whole-token integer validation — parseInt would take '1ms' and '1.5' as 1.
  for (const partial of ['1ms', '1.5', '2e3x', ' ']) {
    assert.throws(() => parseArgs(['/p', '--debounce-ms', partial]), /positive integer/,
      `${JSON.stringify(partial)} must be rejected, not partially parsed`);
    assert.throws(() => parseArgs(['/p', '--sweep-interval-ms', partial]), /positive integer/);
    assert.throws(() => parseArgs(['/p', '--timeout-ms', partial]), /positive integer/);
  }
});

test('a project without a _memories store exits 1 and emits no protocol line', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mvw-nostore-'));
  try {
    const w = spawnWatcher(join(base, 'empty-proj'), ['--timeout-ms', '5000']);
    const { code } = await w.exited;
    assert.equal(code, 1);
    assert.equal(w.getOut(), '', 'no stdout protocol line on config error');
    assert.match(w.getErr(), /no _memories store/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// Degraded sweep-only mode — resource exhaustion must never kill live mode.
// ===========================================================================

const deafWatch = () => ({ on() {}, close() {} });

function makeStoreWithArchive(n = 2) {
  const s = makeStore(n);
  mkdirSync(join(s.memories, 'archive'), { recursive: true });
  writeFileSync(join(s.memories, 'archive', 'old.md'),
    `---\nid: old\ntype: observation\nstatus: archived\n---\n\nArchived body.\n`);
  return s;
}

// REAL EMFILE, no injection: exhaust this process's fd table, arm with the
// real fs.watch, watch fs.watch fail for real, and prove the watcher lives
// on in sweep-only mode. Deterministic wherever the fd table is exhaustible;
// skips honestly (with the reason stated) where the platform will not
// cooperate — the injected variants below run everywhere regardless.
test('REAL fd exhaustion: fs.watch EMFILE at arm degrades to sweep-only and detection survives', async (t) => {
  const { base, proj } = makeStore(3);
  const held = [];
  const statuses = [];
  const events = [];
  const codes = [];
  let handle = null;
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    try {
      for (let i = 0; i < 300000; i++) held.push(openSync(join(proj, '_memories', 'unit-1.md'), 'r'));
    } catch (e) {
      if (e.code !== 'EMFILE' && e.code !== 'ENFILE') throw e;
    }
    if (held.length === 300000) { t.skip('could not exhaust the fd table on this machine'); return; }
    handle = startWatcher({
      projectDir: proj,
      debounceMs: 50,
      sweepIntervalMs: 600000,
      timeoutMs: 60000,
      baselineSnapshot: baseline,
      emit: (e) => events.push(e),
      status: (s) => statuses.push(s),
      exit: (c) => codes.push(c),
      diag: () => {},
      // no watchFn injection: the REAL fs.watch meets the real EMFILE
    });
    // Release the table SYNCHRONOUSLY: the initial check reads the store
    // after a setImmediate yield, so it must find free descriptors again.
    for (const f of held) { try { closeSync(f); } catch { /* closed */ } }
    held.length = 0;
    if (statuses.length === 0) {
      if (handle) handle._stopQuiet();
      t.skip('fs.watch survived a full fd table on this platform — real EMFILE not forcible here');
      return;
    }
    assert.equal(statuses[0].event, 'degraded');
    assert.equal(statuses[0].reason, 'emfile');
    assert.equal(statuses[0].mode, 'sweep-only');
    assert.ok(handle, 'startWatcher must return a live handle, not die');
    assert.deepEqual(codes, [], 'arm-time exhaustion is degradation, never an exit');
    await handle.armed;
    assert.deepEqual(events, [], 'unchanged store emits nothing while degraded');

    writeFileSync(join(proj, '_memories', 'unit-2.md'), unitContent('unit-2', 'Changed while degraded, for real.'));
    const expected = computeCurrentSnapshot(proj);
    await handle.sweepTick();
    await waitFor(() => events.length > 0, 5000, 'sweep detection in degraded mode');
    assert.equal(events[0].event, 'store-changed');
    assert.equal(events[0].trigger, 'sweep');
    assert.equal(events[0].snapshot_id, expected.snapshotId);
    assert.deepEqual(codes, [0]);
  } finally {
    for (const f of held) { try { closeSync(f); } catch { /* closed */ } }
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

test('injected SYNC EMFILE at arm: one degraded status line, no exit 1, sweep still detects', async () => {
  const { base, proj } = makeStore(2);
  const statuses = [];
  const events = [];
  const codes = [];
  let handle = null;
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    handle = startWatcher({
      projectDir: proj,
      debounceMs: 50,
      sweepIntervalMs: 600000,
      timeoutMs: 60000,
      baselineSnapshot: baseline,
      emit: (e) => events.push(e),
      status: (s) => statuses.push(s),
      exit: (c) => codes.push(c),
      diag: () => {},
      watchFn: () => { throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }); },
    });
    assert.ok(handle, 'a live handle despite the sync throw');
    assert.deepEqual(codes, [], 'no exit — the old behavior here was exit 1');
    assert.equal(statuses.length, 1, 'exactly one degraded status line');
    assert.equal(statuses[0].event, 'degraded');
    assert.equal(statuses[0].reason, 'emfile');
    assert.equal(statuses[0].mode, 'sweep-only');
    assert.equal(statuses[0].sweep_interval_ms, 600000, 'the degraded SLO is stated in the line itself');
    assertIso(statuses[0].observed_at);
    await handle.armed;

    writeFileSync(join(proj, '_memories', 'unit-1.md'), unitContent('unit-1', 'Post-EMFILE mutation.'));
    const expected = computeCurrentSnapshot(proj);
    await handle.sweepTick();
    await waitFor(() => events.length > 0, 5000, 'sweep-only detection');
    assert.equal(events[0].event, 'store-changed');
    assert.equal(events[0].trigger, 'sweep');
    assert.equal(events[0].snapshot_id, expected.snapshotId);
    assert.deepEqual(codes, [0]);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

test('injected ASYNC EMFILE after arm: degraded status line once, watcher keeps sweeping', async () => {
  const { base, proj } = makeStore(2);
  const statuses = [];
  const events = [];
  const codes = [];
  let errorCb = null;
  let handle = null;
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    handle = startWatcher({
      projectDir: proj,
      debounceMs: 50,
      sweepIntervalMs: 600000,
      timeoutMs: 60000,
      baselineSnapshot: baseline,
      emit: (e) => events.push(e),
      status: (s) => statuses.push(s),
      exit: (c) => codes.push(c),
      diag: () => {},
      watchFn: () => ({ on(ev, cb) { if (ev === 'error') errorCb = cb; }, close() {} }),
    });
    await handle.armed;
    const emfile = Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
    errorCb(emfile);
    errorCb(emfile); // a second error must not produce a second status line
    assert.deepEqual(codes, [], 'async resource exhaustion is degradation, never exit 1');
    assert.equal(statuses.length, 1, 'degraded is emitted exactly once');
    assert.equal(statuses[0].reason, 'emfile');

    await handle.sweepTick();
    await delay(50);
    assert.deepEqual(events, [], 'no change yet — degraded mode must not fabricate one');

    writeFileSync(join(proj, '_memories', 'unit-2.md'), unitContent('unit-2', 'Changed after async EMFILE.'));
    const expected = computeCurrentSnapshot(proj);
    await handle.sweepTick();
    await waitFor(() => events.length > 0, 5000, 'sweep detection after degrade');
    assert.equal(events[0].trigger, 'sweep');
    assert.equal(events[0].snapshot_id, expected.snapshotId);
    assert.deepEqual(codes, [0]);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a NON-resource watcher error still exits 1 — degradation is for exhaustion only', async () => {
  const { base, proj } = makeStore(2);
  const statuses = [];
  const events = [];
  const codes = [];
  let errorCb = null;
  let handle = null;
  try {
    handle = startWatcher({
      projectDir: proj,
      sweepIntervalMs: 600000,
      timeoutMs: 60000,
      baselineSnapshot: computeCurrentSnapshot(proj).snapshotId,
      emit: (e) => events.push(e),
      status: (s) => statuses.push(s),
      exit: (c) => codes.push(c),
      diag: () => {},
      watchFn: () => ({ on(ev, cb) { if (ev === 'error') errorCb = cb; }, close() {} }),
    });
    await handle.armed;
    errorCb(Object.assign(new Error('watch handle torn down'), { code: 'EACCES' }));
    assert.deepEqual(codes, [1], 'non-resource death must surface as exit 1 for a healthy restart');
    assert.deepEqual(statuses, [], 'no degraded line for a non-resource error');
    assert.deepEqual(events, [], 'no protocol line either');
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// Scoped identity — the watcher compares the same-scoped id the renderer
// receipts; archive edits wake archive views and never active ones.
// ===========================================================================

test('scope threading: an archive-only edit never wakes an active-scoped watcher, and wakes an archive-scoped one', async () => {
  const { base, proj } = makeStoreWithArchive(2);
  try {
    const activeBaseline = computeCurrentSnapshot(proj, { scope: 'active' }).snapshotId;
    const archiveBaseline = computeCurrentSnapshot(proj, { scope: 'all-including-archive' }).snapshotId;
    assert.notEqual(activeBaseline, archiveBaseline, 'the two scopes must have distinct identities');
    assert.equal(computeCurrentSnapshot(proj, { scope: 'all-including-archive' }).activeSnapshotId,
      activeBaseline, 'activeSnapshotId rides along for baseline matching');

    writeFileSync(join(proj, '_memories', 'archive', 'old.md'),
      `---\nid: old\ntype: observation\nstatus: archived\n---\n\nArchive bytes changed.\n`);

    // Active scope: the archive edit is invisible — no wake, ever.
    const eventsA = []; const codesA = [];
    const hA = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000,
      baselineSnapshot: activeBaseline, scope: 'active',
      emit: (e) => eventsA.push(e), exit: (c) => codesA.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await hA.armed;
    await hA.sweepTick();
    await delay(50);
    assert.deepEqual(eventsA, [], 'active scope ignores archive-only changes');
    assert.deepEqual(codesA, []);
    hA._stopQuiet();

    // Archive scope, armed on the PRE-edit id: the immediate arm-time
    // comparison catches it — the same-scoped id, not a raw signature.
    const eventsB = []; const codesB = [];
    const hB = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000,
      baselineSnapshot: archiveBaseline, scope: 'all-including-archive',
      emit: (e) => eventsB.push(e), exit: (c) => codesB.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await hB.armed;
    await delay(50);
    assert.equal(eventsB.length, 1, 'archive scope must wake on the archive edit');
    assert.equal(eventsB[0].trigger, 'sweep');
    assert.equal(eventsB[0].snapshot_id,
      computeCurrentSnapshot(proj, { scope: 'all-including-archive' }).snapshotId,
      'the emitted id is the same-scoped id the renderer would receipt');
    assert.deepEqual(codesB, [0]);
    hB._stopQuiet();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unlabeled archive-scoped baseline arms WITHOUT a false wake and locks its scope from the baseline', async () => {
  const { base, proj } = makeStoreWithArchive(2);
  const events = []; const codes = [];
  let handle = null;
  try {
    const archiveBaseline = computeCurrentSnapshot(proj, { scope: 'all-including-archive' }).snapshotId;
    handle = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000,
      baselineSnapshot: archiveBaseline, // NO scope given — must be inferred, not misread
      emit: (e) => events.push(e), exit: (c) => codes.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await handle.armed;
    await handle.sweepTick();
    await delay(50);
    // The incomparable-identity defect: comparing this baseline to the
    // active-scoped id (or to a raw signature) reports "changed" here.
    assert.deepEqual(events, [], 'an unchanged store must never wake, whatever scope the baseline came from');

    writeFileSync(join(proj, '_memories', 'archive', 'old.md'),
      `---\nid: old\ntype: observation\nstatus: archived\n---\n\nLive archive change.\n`);
    await handle.sweepTick();
    await waitFor(() => events.length > 0, 5000, 'archive change detection under the locked scope');
    assert.equal(events[0].snapshot_id,
      computeCurrentSnapshot(proj, { scope: 'all-including-archive' }).snapshotId);
    assert.deepEqual(codes, [0]);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// The exit window and the deferral door.
// ===========================================================================

test('a write landing between detection and exit is caught by the NEXT arm\'s immediate check', async () => {
  const { base, proj } = makeStore(3);
  try {
    const b0 = computeCurrentSnapshot(proj).snapshotId;
    const events1 = []; const codes1 = [];
    const w1 = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000, baselineSnapshot: b0,
      emit: (e) => events1.push(e), exit: (c) => codes1.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await w1.armed;
    writeFileSync(join(proj, '_memories', 'unit-1.md'), unitContent('unit-1', 'First change.'));
    await w1.sweepTick();
    await waitFor(() => events1.length > 0, 5000, 'first detection');
    const x1 = events1[0].snapshot_id;
    assert.deepEqual(codes1, [0]); // watcher 1 has "exited"

    // The mid-exit write: lands after watcher 1 reported, before any new arm.
    writeFileSync(join(proj, '_memories', 'unit-2.md'), unitContent('unit-2', 'Landed mid-exit.'));
    const expected = computeCurrentSnapshot(proj);
    assert.notEqual(expected.snapshotId, x1);

    // Re-arm on the id watcher 1 reported (what the supervisor would baseline
    // if its render raced the write): the arm-time comparison catches the
    // mid-exit write IMMEDIATELY — no new event, no five-minute sweep needed.
    const events2 = []; const codes2 = [];
    const w2 = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000, baselineSnapshot: x1,
      emit: (e) => events2.push(e), exit: (c) => codes2.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await w2.armed;
    await delay(50);
    assert.equal(events2.length, 1, 'the next arm must catch the mid-exit write at once');
    assert.equal(events2[0].trigger, 'sweep');
    assert.equal(events2[0].snapshot_id, expected.snapshotId);
    assert.deepEqual(codes2, [0]);
    w2._stopQuiet();
    w1._stopQuiet();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('retry_at holds a deliberately-stale baseline without busy-looping, then compares exactly once', async () => {
  const { base, proj } = makeStore(2);
  const events = []; const codes = [];
  let handle = null;
  try {
    const stale = computeCurrentSnapshot(proj).snapshotId;
    writeFileSync(join(proj, '_memories', 'unit-1.md'), unitContent('unit-1', 'Deferred by budget.'));
    handle = startWatcher({
      projectDir: proj, sweepIntervalMs: 100, timeoutMs: 60000,
      baselineSnapshot: stale, retryAtMs: Date.now() + 500,
      emit: (e) => events.push(e), exit: (c) => codes.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await handle.armed;
    assert.deepEqual(events, [], 'the arm-time check must hold before retry_at');
    await delay(200); // several sweep intervals INSIDE the hold window
    await handle.sweepTick();
    assert.deepEqual(events, [], 'sweeps must hold too — no busy-loop against the stale baseline');
    await waitFor(() => events.length > 0, 5000, 'the deferred comparison after retry_at');
    assert.equal(events.length, 1, 'exactly one wake when the window reopens');
    assert.equal(events[0].event, 'store-changed');
    assert.deepEqual(codes, [0]);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// The persisted loop-state record.
// ===========================================================================

test('writeLiveState/readLiveState: whole-record replace, schema validated, corrupt reads fail soft', () => {
  const base = mkdtempSync(join(tmpdir(), 'mvw-state-'));
  const p = join(base, 'ws', 'memory-view-live.json');
  try {
    const rec = writeLiveState(p, {
      artifactUrl: 'https://claude.ai/artifacts/x', scope: 'all-including-archive',
      excludeTopics: ['secret-topic'], baselineSnapshot: 'abc123',
      publishCount: 3, windowStart: '2026-07-30T23:00:00Z', retryAt: '2026-07-31T00:00:00Z',
      grantBasis: 'standing authorization, granted 2026-07-01, recorded in harness memory',
    });
    assert.equal(rec.kind, LIVE_STATE_KIND);
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(onDisk, rec, 'returned record == bytes on disk');
    assert.deepEqual(onDisk.excluded_topics, ['secret-topic']);
    assert.equal(onDisk.grant_basis, 'standing authorization, granted 2026-07-01, recorded in harness memory',
      'the grant rides in the record, bound to the scope/exclusions beside it');
    assert.equal(onDisk.scope, 'all-including-archive');
    assert.equal(onDisk.baseline_snapshot, 'abc123');
    assert.equal(onDisk.publish_budget.count, 3);
    assert.equal(onDisk.publish_budget.window_start, '2026-07-30T23:00:00.000Z');
    assert.equal(onDisk.retry_at, '2026-07-31T00:00:00.000Z');
    assert.deepEqual(readdirSync(join(base, 'ws')), ['memory-view-live.json'],
      'atomic replace leaves no tmp siblings behind');
    assert.equal(readLiveState(p).baseline_snapshot, 'abc123');

    assert.equal(readLiveState(join(base, 'absent.json')), null, 'absent record reads null');
    writeFileSync(p, '{corrupt');
    assert.equal(readLiveState(p), null, 'corrupt record reads null, never throws');

    assert.throws(() => writeLiveState(p, { artifactUrl: 'u', scope: 'everything', baselineSnapshot: 'b' }), /--scope/);
    assert.throws(() => writeLiveState(p, { scope: 'active', baselineSnapshot: 'b' }), /--artifact-url/);
    assert.throws(() => writeLiveState(p, { artifactUrl: 'u', scope: 'active' }), /--baseline-snapshot/);
    assert.throws(() => writeLiveState(p, { artifactUrl: 'u', scope: 'active', baselineSnapshot: 'b', grantBasis: 'g', retryAt: 'soonish' }), /ISO/);
    // The writer boundary refuses a record without its prospective grant, and
    // validates the budget count as a whole-token non-negative integer.
    assert.throws(() => writeLiveState(p, { artifactUrl: 'u', scope: 'active', baselineSnapshot: 'b' }), /--grant-basis/);
    assert.throws(() => writeLiveState(p, { artifactUrl: 'u', scope: 'active', baselineSnapshot: 'b', grantBasis: '  ' }), /--grant-basis/);
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => writeLiveState(p, { artifactUrl: 'u', scope: 'active', baselineSnapshot: 'b', grantBasis: 'g', publishCount: bad }),
        /non-negative integer/,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('CLI: --write-live-state composes the record and --live-state arms from it (scope comes from the record, not a default)', async () => {
  const { base, proj } = makeStoreWithArchive(2);
  try {
    const staleArchiveId = computeCurrentSnapshot(proj, { scope: 'all-including-archive' }).snapshotId;
    // The archive-only edit leaves the ACTIVE id untouched: only a watcher
    // honoring the record's scope can see this change at all.
    writeFileSync(join(proj, '_memories', 'archive', 'old.md'),
      `---\nid: old\ntype: observation\nstatus: archived\n---\n\nRecord-scoped change.\n`);
    const statePath = join(base, 'memory-view-live.json');

    const wrote = spawnSync(process.execPath, [WATCH, '--write-live-state', statePath,
      '--artifact-url', 'https://claude.ai/artifacts/x', '--scope', 'all-including-archive',
      '--exclude-topic', 'secret-topic', '--baseline-snapshot', staleArchiveId,
      '--grant-basis', 'standing authorization, granted 2026-07-01, recorded in harness memory',
    ], { encoding: 'utf8' });
    assert.equal(wrote.status, 0, wrote.stderr);
    assert.equal(JSON.parse(wrote.stdout).kind, LIVE_STATE_KIND);

    const w = spawnWatcher(proj, ['--live-state', statePath, '--sweep-interval-ms', '600000', '--timeout-ms', '30000']);
    const { code } = await w.exited;
    assert.equal(code, 0, `stderr: ${w.getErr()}`);
    const ev = JSON.parse(protocolLines(w.getOut())[0]);
    assert.equal(ev.event, 'store-changed');
    // The compared identity honors the record's scope AND its exclusions —
    // an active-scope or exclusion-blind default would report the wrong id.
    const current = computeCurrentSnapshot(proj,
      { scope: 'all-including-archive', excludeTopics: ['secret-topic'] });
    assert.equal(ev.snapshot_id, current.snapshotId,
      'the emitted id is the record-scoped, record-excluded id');
    assert.notEqual(ev.snapshot_id, current.activeSnapshotId);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// Lifecycle and I/O honesty.
// ===========================================================================

test('orphan self-check: a watcher whose owner is gone emits "orphaned" and exits 4 on its own', async () => {
  const { base, proj } = makeStore(2);
  const events = []; const codes = [];
  let handle = null;
  try {
    // A real process that is already dead — its pid is the "owner".
    const deadOwner = spawnSync(process.execPath, ['-e', '']);
    const deadPid = deadOwner.pid;
    handle = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000,
      baselineSnapshot: computeCurrentSnapshot(proj).snapshotId,
      parentPid: deadPid,
      emit: (e) => events.push(e), exit: (c) => codes.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await waitFor(() => codes.length > 0, 3000, 'orphan self-detection');
    assert.deepEqual(codes, [4], 'an orphan stops itself with the dedicated exit code');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'orphaned');
    assert.equal(events[0].parent_pid, deadPid);
    assertIso(events[0].observed_at);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

test('orphan self-check stays quiet while the owner is alive', async () => {
  const { base, proj } = makeStore(2);
  const events = []; const codes = [];
  let handle = null;
  try {
    handle = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000,
      baselineSnapshot: computeCurrentSnapshot(proj).snapshotId,
      parentPid: process.pid, // this test process — very much alive
      emit: (e) => events.push(e), exit: (c) => codes.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await handle.armed;
    await delay(200); // several orphan-check intervals
    assert.deepEqual(events, [], 'a living owner must never trigger the orphan door');
    assert.deepEqual(codes, []);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a failed terminal emit (EPIPE) exits 1 with a diagnostic — exit 0 always means the wake line landed', async () => {
  const { base, proj } = makeStore(2);
  const codes = []; const diags = [];
  let handle = null;
  try {
    const baseline = computeCurrentSnapshot(proj).snapshotId;
    handle = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000, baselineSnapshot: baseline,
      emit: () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); },
      exit: (c) => codes.push(c), diag: (m) => diags.push(m), watchFn: deafWatch,
    });
    await handle.armed;
    writeFileSync(join(proj, '_memories', 'unit-1.md'), unitContent('unit-1', 'Change nobody will hear.'));
    await handle.sweepTick();
    await waitFor(() => codes.length > 0, 3000, 'emit-failure exit');
    assert.deepEqual(codes, [1], 'a swallowed wake line must never exit 0');
    assert.match(diags.join('\n'), /emit failed/i);
  } finally {
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});

test('parseArgs/parseWriteLiveStateArgs: the new flags validate closed', () => {
  assert.throws(() => parseArgs(['/p', '--scope', 'everything']), /--scope must be one of/);
  const s = parseArgs(['/p', '--scope', 'all-including-archive', '--live-state', '/tmp/x.json']);
  assert.equal(s.scope, 'all-including-archive');
  assert.equal(s.liveStatePath, '/tmp/x.json');
  assert.equal(parseArgs(['/p']).scope, null, 'scope defaults to null → locked from the baseline');

  assert.throws(() => parseWriteLiveStateArgs(['--write-live-state']), /requires a value/);
  assert.throws(() => parseWriteLiveStateArgs(['--write-live-state', '/p', '--bogus']), /unknown flag/);
  assert.equal(parseWriteLiveStateArgs(['--write-live-state', '/p', '--publish-count', '4']).publishCount, 4);
  assert.throws(() => parseWriteLiveStateArgs(['--write-live-state', '/p', '--publish-count', '-1']), /non-negative/);
  // Whole-token validation on EVERY integer flag, both parser modes: parseInt
  // would silently truncate '1ms' and '1.5' to 1.
  for (const bad of ['1ms', '1.5']) {
    assert.throws(() => parseArgs(['/p', '--debounce-ms', bad]), /positive integer/);
    assert.throws(() => parseWriteLiveStateArgs(['--write-live-state', '/p', '--publish-count', bad]), /non-negative integer/);
  }
});

posixTest('the CLI entry runs under a symlinked path spelling — a refusal never vanishes into a silent exit 0', () => {
  // Node realpaths the ESM entry (--preserve-symlinks-main off), so a naive
  // as-spelled isMain comparison goes false through any symlinked component
  // and the CLI silently no-ops: exit 0, empty stdout, empty stderr — a
  // supervisor reads a vanished refusal as success. The entry guard must
  // match both spellings.
  const { base, proj } = makeStore(1);
  try {
    const linkDir = join(base, 'scripts-link');
    symlinkSync(SCRIPTS, linkDir);
    const run = spawnSync(process.execPath,
      [join(linkDir, 'memory-view-watch.mjs'), proj, '--live-state', join(base, 'missing.json'),
        '--timeout-ms', '25', '--sweep-interval-ms', '25'],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 1,
      `a symlinked spelling of the watcher must still run main and refuse: status=${run.status} stderr=${JSON.stringify(run.stderr)}`);
    assert.match(run.stderr, /refusing to arm/, 'the refusal diagnostic must land on the pipe');
    assert.equal(run.stdout, '');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('an explicit --live-state record the watcher cannot honor refuses to arm (exit 1, named reason, no protocol line)', () => {
  const { base, proj } = makeStore(1);
  try {
    const missing = join(base, 'missing.json');
    const corrupt = join(base, 'corrupt.json');
    writeFileSync(corrupt, '{');
    const wrongSchema = join(base, 'wrong.json');
    writeFileSync(wrongSchema, JSON.stringify({
      kind: 'some-other-record', scope: 'active', baseline_snapshot: 'bogus', retry_at: 'not-a-date',
    }));
    for (const statePath of [missing, corrupt, wrongSchema]) {
      const run = spawnSync(process.execPath,
        [WATCH, proj, '--live-state', statePath, '--timeout-ms', '25', '--sweep-interval-ms', '25'],
        { encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 1, `an unusable explicit record is a config error, never a silent default: ${run.stderr}`);
      assert.equal(run.stdout, '', 'no lifecycle event may be emitted');
      assert.match(run.stderr, /refusing to arm/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

posixTest('an unreadable store during a check emits check-failed and holds the baseline — never a store-changed wake', async () => {
  const { base, proj, memories } = makeStore(2);
  const events = []; const statuses = []; const codes = [];
  let handle = null;
  try {
    handle = startWatcher({
      projectDir: proj, sweepIntervalMs: 600000, timeoutMs: 60000,
      baselineSnapshot: computeCurrentSnapshot(proj).snapshotId,
      emit: (e) => events.push(e), status: (s) => statuses.push(s),
      exit: (c) => codes.push(c), diag: () => {}, watchFn: deafWatch,
    });
    await handle.armed;
    chmodSync(memories, 0o000); // total traversal failure — reads collapse
    try {
      await handle.sweepTick();
    } finally {
      chmodSync(memories, 0o755);
    }
    assert.deepEqual(events, [], 'an incomplete capture must not fabricate a change (or an empty store)');
    assert.deepEqual(codes, [], 'the loop must stay armed for a later complete sweep');
    assert.equal(statuses.length, 1, 'exactly one typed diagnostic per failed check');
    assert.equal(statuses[0].event, 'check-failed');
    assert.equal(statuses[0].reason, 'store-read-incomplete');
    assert.ok(statuses[0].read_errors > 0);

    // The store is readable again: a REAL change must still be detected.
    writeFileSync(join(memories, 'unit-1.md'), unitContent('unit-1', 'Changed after recovery.'));
    await handle.sweepTick();
    await waitFor(() => events.length > 0, 5000, 'post-recovery detection');
    assert.equal(events[0].event, 'store-changed');
    assert.deepEqual(codes, [0]);
  } finally {
    try { chmodSync(memories, 0o755); } catch { /* already restored */ }
    if (handle) handle._stopQuiet();
    rmSync(base, { recursive: true, force: true });
  }
});
