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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const WATCH = join(SCRIPTS, 'memory-view-watch.mjs');

const {
  startWatcher, createCoalescer, sweepStatSet, shouldIgnoreRel,
  computeCurrentSnapshot, parseArgs,
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
    const w = spawnWatcher(proj, ['--debounce-ms', '250', '--sweep-interval-ms', '600000', '--timeout-ms', '30000', '--baseline-snapshot', baseline]);
    await w.armed;

    for (let i = 0; i < 20; i++) {
      const file = `unit-${(i % 3) + 1}.md`;
      writeFileSync(join(proj, '_memories', file), unitContent(file.replace(/\.md$/, ''), `Burst revision ${i}.`));
      await delay(10); // spread the burst so a leading-edge check would see an intermediate state
    }
    const expected = computeCurrentSnapshot(proj); // final state, after all 20 writes

    const { code } = await w.exited;
    assert.equal(code, 0, `expected change-detected exit 0, stderr: ${w.getErr()}`);
    const lines = stdoutLines(w.getOut());
    assert.equal(lines.length, 1, `exactly one stdout line, got: ${JSON.stringify(lines)}`);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'store-changed');
    assert.equal(ev.trigger, 'watch');
    assert.equal(ev.snapshot_id, expected.snapshotId, 'must report the post-burst FINAL snapshot id — trailing debounce');
    assert.equal(ev.units_seen, expected.unitsSeen);
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
    const w = spawnWatcher(proj, ['--debounce-ms', '150', '--sweep-interval-ms', '600000', '--timeout-ms', '30000', '--baseline-snapshot', baseline]);
    await w.armed;

    atomicWriteFileSync(join(proj, '_memories', 'unit-new.md'), unitContent('unit-new', 'Atomically written unit.'));
    const expected = computeCurrentSnapshot(proj);

    const { code } = await w.exited;
    assert.equal(code, 0, `stderr: ${w.getErr()}`);
    const lines = stdoutLines(w.getOut());
    assert.equal(lines.length, 1, `exactly one stdout line, got: ${JSON.stringify(lines)}`);
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
    assert.equal(w.getOut(), '', 'no event may be emitted for an unchanged store');
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
    const lines = stdoutLines(w.getOut());
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
    const lines = stdoutLines(w.getOut());
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
    assert.equal(JSON.parse(stdoutLines(w.getOut())[0]).signal, 'SIGINT');
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

    assert.equal(w.getOut(), '', 'filtered writes must not produce any event');
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
    const lines = stdoutLines(w.getOut());
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
