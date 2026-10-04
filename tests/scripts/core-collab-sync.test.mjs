// End-to-end handoff: a real collab round (collab-plugin's own scripts) into a CORE project.
// Needs collab's scripts: $COLLAB_SCRIPTS_DIR, else the sibling checkout ../collab-plugin. Skips by name without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, '../../plugins/core/skills/core/scripts');
const COLLAB = process.env.COLLAB_SCRIPTS_DIR || resolve(__dirname, '../../../collab-plugin/skills/collab/scripts');
const HAVE_COLLAB = existsSync(join(COLLAB, 'collab-outcome.mjs'));
const skip = HAVE_COLLAB ? false : `collab-outcome.mjs not found at ${COLLAB}`;

const ROOT = mkdtempSync(join(tmpdir(), 'core-collab-sync-'));
process.env.COLLAB_LOCAL_ROOT = join(ROOT, 'local');
process.env.COLLAB_STATE_ROOT = join(ROOT, 'state');
const { syncCollab } = await import(pathToFileURL(join(SCRIPTS, 'core-collab-sync.mjs')).href);
const R1 = 'core-codex@codex:host';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-proj-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  mkdirSync(join(dir, '_sources'), { recursive: true });
  writeFileSync(join(dir, '_sources', 'collab.yaml'), 'name: collab\n');
  return dir;
}
const inbox = (dir) => (existsSync(join(dir, 'inbox.md')) ? readFileSync(join(dir, 'inbox.md'), 'utf8') : '');
const blocks = (dir) => (inbox(dir).match(/^handoff-collab-id: /gm) || []).length;

let collab = null;
async function round(tag) {
  collab ??= {
    ...(await import(pathToFileURL(join(COLLAB, 'collab-kickoff.mjs')).href)),
    ...(await import(pathToFileURL(join(COLLAB, 'collab-event-helpers.mjs')).href)),
    ...(await import(pathToFileURL(join(COLLAB, 'collab-tick.mjs')).href)),
  };
  const k = await collab.kickoff(`sync round ${tag}`, {
    workspaceId: 'sync-test', transport: 'localhost', capabilitiesWanted: ['review'],
    measures: [{ id: 'M-1', description: 'the handoff lands once', requires_review_from: R1 }],
  });
  const at = (m) => new Date(Date.now() - (30 - m) * 60000).toISOString();
  const add = (author, type, m, payload, refs = []) => { const e = { event_id: `evt-${tag}-${type}`, ts: at(m), author, slug: k.slug, type, references: refs, payload }; collab.appendEvent(k.dir, e); return e; };
  add(R1, 'join', 1, { capability_match: [], commitment: 'review', owes_review: ['M-1'] }, [k.kickoffEvt.event_id]);
  const pc = add(k.triplet, 'propose-close', 2, { synthesis: 's', igm_met: {} });
  return { k, add, pc, close: async () => {
    add(R1, 'ratify', 3, { measures: ['M-1'] }, [pc.event_id]);
    const r = await collab.tickDeterministic(k.slug, { workspaceId: 'sync-test', triplet: k.triplet, dryRun: false });
    assert.equal(r.action, 'close');
  } };
}
const sync = (dir, extra = {}) => syncCollab(dir, { participant: R1, collabCli: COLLAB, collabRoot: process.env.COLLAB_LOCAL_ROOT, ...extra });
const stateOf = (res, slugPart) => res.items.find(i => i.collab.includes(slugPart))?.state;

test('collab absent: sync is a named no-op', () => {
  const dir = project();
  const r = syncCollab(dir, { participant: R1, collabCli: join(ROOT, 'nowhere') });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /not installed/);
  assert.equal(inbox(dir), '');
  rmSync(dir, { recursive: true, force: true });
});

test('open collab is reported open; after close it lands exactly once; reruns are already-landed', { skip }, async () => {
  const dir = project();
  const x = await round('e2e');
  assert.equal(stateOf(sync(dir), 'sync-round-e2e'), 'open');
  await x.close();
  assert.equal(stateOf(sync(dir), 'sync-round-e2e'), 'landed');
  assert.equal(stateOf(sync(dir), 'sync-round-e2e'), 'already-landed');
  assert.equal(blocks(dir), 1);
  const log = readFileSync(join(dir, '_sessions', new Date().toISOString().slice(0, 10), 'handoff-log.jsonl'), 'utf8').trim().split('\n');
  assert.ok(log.length >= 3, 'every run logged');
  rmSync(dir, { recursive: true, force: true });
});

test('a crash after landing but before the log line, and a late event after close: one block, outcome unchanged', { skip }, async () => {
  const dir = project();
  const x = await round('crash');
  await x.close();
  sync(dir);
  rmSync(join(dir, '_sessions'), { recursive: true, force: true });           // the log write never happened
  const block = inbox(dir);
  x.add(R1, 'note', 40, {});                                                   // a late event anchored after the close
  assert.equal(stateOf(sync(dir), 'sync-round-crash'), 'already-landed');
  assert.equal(inbox(dir), block, 'the landed outcome is byte-unchanged');
  rmSync(dir, { recursive: true, force: true });
});

test('a participant that never joined lands nothing', { skip }, async () => {
  const dir = project();
  const x = await round('stranger');
  await x.close();
  const r = syncCollab(dir, { participant: 'someone-else@codex:host', collabCli: COLLAB, collabRoot: process.env.COLLAB_LOCAL_ROOT });
  assert.equal(stateOf(r, 'sync-round-stranger'), 'not-joined');
  assert.equal(inbox(dir), '');
  rmSync(dir, { recursive: true, force: true });
});

test('a tampered anchored event surfaces as a named refusal and lands nothing', { skip }, async () => {
  const dir = project();
  const x = await round('tamper');
  await x.close();
  const f = join(x.k.dir, 'events', 'evt-tamper-join.json');
  writeFileSync(f, readFileSync(f, 'utf8') + ' ');
  assert.match(stateOf(sync(dir), 'sync-round-tamper'), /^refused:ledger-mutated evt-tamper-join$/);
  assert.ok(!inbox(dir).includes('sync-round-tamper'), 'the tampered collab landed nothing');
  rmSync(dir, { recursive: true, force: true });
});

test('cleanup', () => { rmSync(ROOT, { recursive: true, force: true }); });
