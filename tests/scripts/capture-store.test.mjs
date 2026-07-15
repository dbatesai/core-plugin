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
  // marker as fast as it can, until the stop file appears.
  const writer = `
    import { writeFileSync, renameSync, existsSync } from 'node:fs';
    const fm = ${JSON.stringify(fm)};
    let epoch = 0;
    while (!existsSync(${JSON.stringify(stopFile)})) {
      epoch++;
      const tmp = ${JSON.stringify(unitPath)} + '.tmp';
      writeFileSync(tmp, fm + 'omega speedmaster epoch-' + epoch + ' body\\n');
      renameSync(tmp, ${JSON.stringify(unitPath)});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer], { timeout: 30000 });
  let childErr = '';
  child.stderr.on('data', d => { childErr += d; });
  const childDone = new Promise(res => child.on('close', res));
  await new Promise(r => setTimeout(r, 100)); // let the writer start mutating

  try {
    let sawEpochs = new Set();
    for (let i = 0; i < 25; i++) {
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
      assert.equal(cap.snapshotId, createHash('sha256').update(cap.index.source_sig).digest('hex'),
        'snapshotId is derived from that same signature');
      if (rawEpoch) sawEpochs.add(rawEpoch);
    }
    assert.ok(sawEpochs.size >= 2,
      `the barrier was live — captures observed ${sawEpochs.size} distinct epochs (writer stderr: ${childErr})`);
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
