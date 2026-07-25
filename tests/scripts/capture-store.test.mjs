/**
 * captureStore — the atomic single-read capture (Hale round 11).
 *
 * His deterministic reproduction against the two-walk version:
 * {"id_stayed_old":true,"measured_new_body":true,"fresh_id_changed":true} —
 * loadSnapshot hashed the store in one walk and re-read bodies in another, so a
 * concurrent write between walks made snapshot_id identify OLD bytes while the
 * evaluator measured NEW bytes. The invariant under test here: identity, index,
 * and bodies all derive from ONE read per file, so for any captured file the
 * epoch hashed into the id and the epoch in the measured body CANNOT diverge —
 * proven under a live concurrent writer (barrier-controlled), not argued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

const { loadSnapshot, captureStore } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);

const UNIT_ID = 'want-omega-speedmaster-on-sale-wait';
const UNIT_REL = `${UNIT_ID}.md`;

test('round-11 barrier: under a LIVE concurrent writer, the id and the measured body never diverge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-barrier-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  const unitPath = join(store, '_memories', UNIT_REL);
  const fm = readFileSync(unitPath, 'utf8').match(/^---\n[\s\S]*?\n---\n/)[0];
  const stopFile = join(dir, 'stop');

  // Writer child: atomically rewrites the unit body with an incrementing epoch
  // marker as fast as it can, until the stop file appears. It signals its
  // epoch over IPC after every completed atomic rename. The capture loop
  // proves liveness with a causal probe/ack handshake, not by counting
  // messages that happen to be *delivered* after the loop starts: a message
  // the writer already SENT before the window began can still arrive late
  // (IPC delivery queuing) and be mistaken for in-window progress, which
  // would satisfy a naive "any message after loopStarted" check without the
  // writer having actually advanced during the observed window (Hale,
  // 2026-07-22). Instead: the parent sends 'probe' only after the window
  // starts; the writer can only reply with its current epoch once it has
  // actually processed that probe, which is itself proof the reply's epoch
  // value was read at a point strictly after the window began. Requiring one
  // MORE epoch beyond that value is then genuine in-window advancement, not
  // an artifact of delivery timing. (A fixed sleep proved even less than any
  // of this — Hale's watchdog caught 0-epoch runs, 2026-07-17.)
  const writer = `
    import { writeFileSync, renameSync, existsSync } from 'node:fs';
    const fm = ${JSON.stringify(fm)};
    let epoch = 0;
    let probeAcked = false;
    process.on('message', (m) => {
      if (m === 'probe' && !probeAcked) { probeAcked = true; if (process.send) process.send({ probeAckEpoch: epoch }); }
    });
    // Windows: a concurrent reader holding the target open can EPERM/EBUSY
    // the rename; retry briefly instead of crashing (a dead writer would
    // masquerade as a liveness failure in the parent's window assertions).
    async function renameWithRetry(from, to) {
      for (let a = 0; ; a++) {
        try { renameSync(from, to); return; }
        catch (e) {
          if ((e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') && a < 200) {
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }
          throw e;
        }
      }
    }
    while (!existsSync(${JSON.stringify(stopFile)})) {
      epoch++;
      const tmp = ${JSON.stringify(unitPath)} + '.tmp';
      writeFileSync(tmp, fm + 'omega speedmaster epoch-' + epoch + ' body\\n');
      await renameWithRetry(tmp, ${JSON.stringify(unitPath)});
      if (process.send) process.send({ epoch });
      // setImmediate, not Atomics.wait: Atomics.wait blocks this thread at the
      // OS level and starves this process's OWN event loop, so it would never
      // actually get a chance to process the parent's incoming 'probe'
      // message no matter how long the parent waits (reproduced live: the
      // probe/ack handshake below hung until timeout with the old
      // Atomics.wait spin).
      await new Promise((r) => setImmediate(r));
    }
    // Registering a 'message' listener refs the IPC channel for incoming
    // delivery, so this process no longer exits on its own once the loop
    // above ends -- it would just sit open waiting on the channel forever,
    // hanging the parent's 'await childDone'. Exit explicitly (reproduced
    // live: the whole test hung past its own timeout without this).
    process.exit(0);
  `;
  // timeout must clear the 20s observation window with margin — a harness
  // kill mid-window reads as a liveness failure.
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer], { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let childErr = '';
  child.stderr.on('data', d => { childErr += d; });
  let writerExit = null;
  const childDone = new Promise(res => child.on('close', (code, signal) => { writerExit = { code, signal }; res(); }));

  let probeAckEpoch = null;
  let sawEpochStrictlyAfterAck = false;
  child.on('message', (m) => {
    if (m && typeof m === 'object' && 'probeAckEpoch' in m) probeAckEpoch = m.probeAckEpoch;
    else if (m && typeof m === 'object' && 'epoch' in m && probeAckEpoch !== null && m.epoch > probeAckEpoch) sawEpochStrictlyAfterAck = true;
  });

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('writer never signaled ready')), 15000);
    const onFirstMessage = (m) => { if (m && typeof m === 'object' && 'epoch' in m) { clearTimeout(t); child.off('message', onFirstMessage); res(); } };
    child.on('message', onFirstMessage);
    child.on('close', () => { clearTimeout(t); rej(new Error(`writer exited before ready: ${childErr}`)); });
  });

  try {
    let sawEpochs = new Set();
    child.send('probe'); // sent only now, strictly after the window begins
    // Bounded by wall-clock, not a fixed capture count — under contention the
    // writer just needs more real time to get another scheduling slice, and a
    // fixed iteration count was exactly what made this flaky under load.
    const deadline = Date.now() + 20000;
    let i = 0;
    while (Date.now() < deadline && !(sawEpochs.size >= 2 && sawEpochStrictlyAfterAck)) {
      const cap = loadSnapshot(store, { captureBodies: true, retainRaw: true });
      const raw = cap.raw[UNIT_REL];
      assert.ok(raw, 'mutated unit present in the capture (writer renames atomically)');
      const rawEpoch = /epoch-(\d+)/.exec(raw.toString('utf8'))?.[1];
      const body = cap.bodies.find(b => b.id === UNIT_ID);
      const bodyEpoch = /epoch-(\d+)/.exec(body?.text || '')?.[1];
      // THE invariant: the bytes hashed into the identity and the bytes measured
      // are the same read. Under the old two-walk capture this fails within a
      // few iterations against this writer.
      assert.equal(bodyEpoch, rawEpoch,
        `capture ${i}: body epoch ${bodyEpoch} must equal the epoch of the bytes the id was minted from (${rawEpoch})`);
      const expectedSigEntry = `${UNIT_REL}:${createHash('sha1').update(raw).digest('hex')}`;
      assert.ok(cap.index.source_sig.includes(expectedSigEntry),
        `capture ${i}: source_sig carries the sha1 of the exact bytes read`);
      assert.equal(cap.snapshotId, createHash('sha256')
        .update(`${cap.index.source_sig}|enrichment:${cap.enrichments.digest}`).digest('hex'),
        'snapshotId is derived from the source signature plus valid enrichment identity');
      if (rawEpoch) sawEpochs.add(rawEpoch);
      i++;
      // Yield to the event loop so the child's queued IPC 'message' events
      // actually get delivered — a tight synchronous loop starves them, which
      // would make sawEpochStrictlyAfterAck stay false forever regardless of
      // how long the deadline is (caught live: 121696 captures, 0 signals seen).
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(writerExit, null,
      `the writer died mid-window (exit ${JSON.stringify(writerExit)}) — stderr: ${childErr.slice(0, 800)}`);
    assert.ok(sawEpochs.size >= 2 && sawEpochStrictlyAfterAck,
      `the barrier was live for the whole window — ${sawEpochs.size} distinct epochs across ${i} captures, ` +
      `causal in-window advancement past probe-ack epoch ${probeAckEpoch}: ${sawEpochStrictlyAfterAck} (writer stderr: ${childErr})`);
  } finally {
    writeFileSync(stopFile, '1');
    await childDone;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round-11: two captures spanning a mutation mint DIFFERENT ids; identical states mint the same id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-epochs-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  const unitPath = join(store, '_memories', UNIT_REL);
  const fm = readFileSync(unitPath, 'utf8').match(/^---\n[\s\S]*?\n---\n/)[0];
  try {
    const a = captureStore(store);
    const a2 = captureStore(store);
    assert.equal(a.snapshotId, a2.snapshotId, 'unchanged bytes → same id');
    writeFileSync(unitPath, fm + 'omega speedmaster epoch-mutated body\n');
    const b = captureStore(store);
    assert.notEqual(b.snapshotId, a.snapshotId, 'mutated bytes → different id');
    assert.match(b.bodies.find(x => x.id === UNIT_ID).text, /epoch-mutated/,
      'and the new id\'s capture measures the new bytes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Hale round 12: edge expansion used to re-read live unit files after the id was
// minted — a concurrent EDGE change altered expanded/final results under an
// unchanged snapshot_id. His required proof: a barrier-controlled concurrent-edge
// writer, with snapshot_id, expansion, final results, and the trace all agreeing
// with the SAME captured state, every iteration.
test('round-12 barrier: under a LIVE concurrent EDGE writer, expansion/final/trace always match the captured bytes', async () => {
  const { buildRetrievalTrace } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
  const { parseFrontmatter, extractEdges } = await import(pathToFileURL(join(SCRIPTS, 'priority.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'edge-barrier-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  const unitPath = join(store, '_memories', UNIT_REL);
  const stopFile = join(dir, 'stop');
  // Two edge targets that exist in the fixture, alternated by the writer.
  const targets = ['values-heritage', 'want-iconic-chronograph'];
  const bodyOf = (t) => `---\nid: ${UNIT_ID}\ntype: want\nstatus: active\nedges:\n  - {type: cites, target: ${t}}\n---\n\nomega speedmaster on sale wait body\n`;

  // Same causal probe/ack handshake as round-11 (see its comment for why a
  // fixed sleep, a single startup signal, and "any message after a flag
  // flips" are all insufficient proof of in-window liveness).
  const writer = `
    import { writeFileSync, renameSync, existsSync } from 'node:fs';
    const bodies = ${JSON.stringify(targets.map(bodyOf))};
    let i = 0;
    let probeAcked = false;
    process.on('message', (m) => {
      if (m === 'probe' && !probeAcked) { probeAcked = true; if (process.send) process.send({ probeAckI: i }); }
    });
    // Same Windows EPERM/EBUSY rename retry as round-11's writer (a reader
    // holding the target open fails the rename; a crashed writer here read
    // as "liveness never advanced past probe-ack" on windows-latest).
    async function renameWithRetry(from, to) {
      for (let a = 0; ; a++) {
        try { renameSync(from, to); return; }
        catch (e) {
          if ((e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') && a < 200) {
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }
          throw e;
        }
      }
    }
    while (!existsSync(${JSON.stringify(stopFile)})) {
      const tmp = ${JSON.stringify(unitPath)} + '.tmp';
      writeFileSync(tmp, bodies[i % 2]);
      await renameWithRetry(tmp, ${JSON.stringify(unitPath)});
      if (process.send) process.send({ i });
      i++;
      await new Promise((r) => setImmediate(r));
    }
    process.exit(0); // see round-11: a 'message' listener refs the IPC channel, so exit explicitly
  `;
  // timeout 90s, NOT 30s: the observation window below is 45s — the old 30s
  // spawn timeout had the harness killing the writer mid-window, which then
  // read as "liveness never advanced" instead of what it was.
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer], { timeout: 90000, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let childErr2 = '';
  child.stderr.on('data', d => { childErr2 += d; });
  let writerExit2 = null;
  const childDone = new Promise(res => child.on('close', (code, signal) => { writerExit2 = { code, signal }; res(); }));

  let probeAckI = null;
  let sawIStrictlyAfterAck = false;
  child.on('message', (m) => {
    if (m && typeof m === 'object' && 'probeAckI' in m) probeAckI = m.probeAckI;
    else if (m && typeof m === 'object' && 'i' in m && probeAckI !== null && m.i > probeAckI) sawIStrictlyAfterAck = true;
  });

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('edge writer never signaled ready')), 15000);
    const onFirstMessage = (m) => { if (m && typeof m === 'object' && 'i' in m) { clearTimeout(t); child.off('message', onFirstMessage); res(); } };
    child.on('message', onFirstMessage);
    child.on('close', () => { clearTimeout(t); rej(new Error(`edge writer exited before ready: ${childErr2}`)); });
  });

  try {
    const seenTargets = new Set();
    child.send('probe'); // sent only now, strictly after the window begins
    // 45s, not 20s: Meridian found this window flakes ~1-in-6 on real Windows
    // hardware (including the very first cold run) even though it's already
    // wall-clock- not iteration-bounded -- Windows process scheduling can
    // give both the writer and this reader loop meaningfully fewer turns per
    // wall-clock second than macOS/Linux, so the SAME correctness proof needs
    // more real time there to reliably observe both alternating targets. The
    // causal probe/ack half (sawIStrictlyAfterAck) was already unaffected --
    // IPC ordering held every time on his box; only the "both targets seen"
    // statistical half needed headroom (2026-07-22).
    const deadline = Date.now() + 45000;
    for (let i = 0; (Date.now() < deadline) && !(seenTargets.size >= 2 && sawIStrictlyAfterAck); i++) {
      const cap = loadSnapshot(store, { captureBodies: true, retainRaw: true });
      const trace = buildRetrievalTrace('omega speedmaster on sale', store, { topN: 3, snapshot: cap });
      assert.equal(trace.snapshot_id, cap.snapshotId, `iter ${i}: trace carries the capture's own id`);
      // Recompute the expected edges from the RAW bytes of this same capture.
      const raw = cap.raw[UNIT_REL].toString('utf8');
      const [fm] = parseFrontmatter(raw);
      const expectedTargets = new Set(extractEdges({ fm }).map(e => e.target));
      // Every expanded hit parented on our unit must be an edge in the captured
      // bytes — never an edge from a different (older/newer) on-disk state.
      const expandedIds = new Set((trace.stages.expansion || []).map(x => x.id));
      for (const t of targets) {
        if (expandedIds.has(t)) {
          assert.ok(expectedTargets.has(t),
            `iter ${i}: expanded '${t}' must come from the captured edges (${[...expectedTargets].join(',')})`);
          seenTargets.add(t);
        }
      }
      // final = top ∪ expanded from the same stages object — internal consistency.
      for (const f of trace.stages.final) {
        assert.ok(trace.stages.top.some(t => t.id === f.id) || expandedIds.has(f.id),
          `iter ${i}: final contains only capture-derived results`);
      }
      await new Promise((r) => setImmediate(r)); // let the writer's probe-ack/i messages actually get delivered
    }
    assert.equal(writerExit2, null,
      `the edge writer died mid-window (exit ${JSON.stringify(writerExit2)}) — stderr: ${childErr2.slice(0, 800)}`);
    assert.ok(seenTargets.size >= 2 && sawIStrictlyAfterAck,
      `the edge barrier was live for the whole window — expansions observed both alternating targets ` +
      `(${[...seenTargets].join(',')}), causal in-window advancement past probe-ack i=${probeAckI}: ${sawIStrictlyAfterAck}`);
  } finally {
    writeFileSync(stopFile, '1');
    await childDone;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Hale round 13: reader-by-reader fixes were masking an incomplete invariant.
// The whole-harness proof: with ONE injected capture, the complete evaluator —
// every arm, the sweep, every manifest field — must produce an identical
// timing-free projection across two runs separated by an on-disk mutation storm.
// Any store access reachable after capture, anywhere in the harness, fails this.
test('round-13 whole-harness barrier: a mutation storm between runs cannot change ANY capture-pinned output', async () => {
  const { runHarness, runTierPolicySweep } = await import(pathToFileURL(join(SCRIPTS, 'retrieval-harness.mjs')).href);
  const { writeFileSync: wf, mkdtempSync: mk, rmSync: rm, readdirSync, appendFileSync } = await import('node:fs');
  const dir = mk(join(tmpdir(), 'whole-harness-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  const goldPath = join(dir, 'gold.json');
  wf(goldPath, JSON.stringify({ queries: [
    { id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: [UNIT_ID], forbidden: ['distractor-retired-rolex'] },
  ] }));
  const projection = (out) => JSON.stringify({
    results: out.results, rawRanks: out.rawRanks, total: out.total, mix: out.mix,
    snapshot_id: out.manifest.snapshot_id, corpus: out.manifest.corpus_content_sha256,
  });
  const sweepProjection = (s) => JSON.stringify({ perPolicy: s.perPolicy, bands: s.bands, snapshot_id: s.snapshot_id, counts: s.counts });
  try {
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const run1 = projection(await runHarness(store, goldPath, { snapshot }));
    const sweep1 = sweepProjection(runTierPolicySweep(store, JSON.parse(readFileSync(goldPath, 'utf8')).queries, { snapshot }));
    // The mutation storm: rewrite EVERY unit with ranking-poisoning content and
    // add a brand-new unit that would rank first if any reader touched the disk.
    const memDir = join(store, '_memories');
    for (const f of readdirSync(memDir, { recursive: true })) {
      if (String(f).endsWith('.md')) appendFileSync(join(memDir, String(f)), '\n\nomega speedmaster sale omega speedmaster sale\n');
    }
    wf(join(memDir, 'poison-new-unit.md'), '---\nid: poison-new-unit\ntype: want\nstatus: active\n---\n\nomega speedmaster sale omega speedmaster sale omega speedmaster sale\n');
    const run2 = projection(await runHarness(store, goldPath, { snapshot }));
    const sweep2 = sweepProjection(runTierPolicySweep(store, JSON.parse(readFileSync(goldPath, 'utf8')).queries, { snapshot }));
    assert.equal(run2, run1, 'the full harness projection is byte-identical across the storm — zero live readers anywhere');
    assert.equal(sweep2, sweep1, 'the full sweep projection is byte-identical across the storm');
    assert.ok(!run2.includes('poison-new-unit'), 'the post-capture unit is invisible to every measured surface');
  } finally { rm(dir, { recursive: true, force: true }); }
});

// Hale round 14: buildRetrievalTrace ran its storeless existsSync probe BEFORE
// honoring an injected snapshot — if the live store vanished after capture, the
// trace returned `storeless` instead of describing the captured state, and the
// round-13 whole-harness barrier couldn't see it (trace was outside the barrier).
test('round-14: with an injected capture, the trace describes the CAPTURED state even when the store is GONE', async () => {
  const { buildRetrievalTrace } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'trace-gone-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  try {
    const cap = loadSnapshot(store, { captureBodies: true });
    rmSync(join(store, '_memories'), { recursive: true, force: true }); // the store VANISHES post-capture
    const trace = buildRetrievalTrace('omega speedmaster sale', store, { topN: 3, snapshot: cap });
    assert.equal(trace.storeless, undefined, 'not storeless — the capture is the state');
    assert.equal(trace.snapshot_id, cap.snapshotId, 'trace carries the capture\'s id');
    assert.ok(trace.stages.final.length > 0, 'results ranked entirely from captured bytes');
    assert.ok(trace.pack.accepted.length > 0, 'the pack delivers from captured bytes');
    // And WITHOUT a snapshot the storeless probe still protects the product path:
    const bare = buildRetrievalTrace('omega speedmaster sale', store, { topN: 3 });
    assert.equal(bare.storeless, true, 'no snapshot + no store → honest storeless report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
