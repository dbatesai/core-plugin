import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, '../../plugins/core/skills/core/scripts');
const { landObservation, sha256 } = await import(pathToFileURL(join(SCRIPTS, 'land-observation.mjs')).href);
const { acquireFileLock, releaseFileLock } = await import(pathToFileURL(join(SCRIPTS, 'file-lock.mjs')).href);
const { checkInbox } = await import(pathToFileURL(join(SCRIPTS, 'check-inbox.mjs')).href);

function project(sources = ['collab', 'bblens']) {
  const dir = mkdtempSync(join(tmpdir(), 'land-obs-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  mkdirSync(join(dir, '_sources'), { recursive: true });
  for (const s of sources) writeFileSync(join(dir, '_sources', `${s}.yaml`), `name: ${s}\n`);
  return dir;
}
const B = (s) => Buffer.from(s, 'utf8');
const OUT = B('{"close":{"event_id":"evt-9"},"schema":"collab-outcome/1","slug":"s"}\n');
const CID = 'a'.repeat(64);
const receipt = (over = {}) => ({ collab_id: CID, origin_anchor: 'localhost:9', outcome_sha256: sha256(OUT), mapping: 'collab-outcome/1', ...over });
const landCollab = (dir, extra = {}) => landObservation(dir, { id: 'obs-collab-aaaaaaaaaaaaaaaa', source: 'collab', bytes: OUT, sha: sha256(OUT), receipt: receipt(), ...extra });
const inbox = (dir) => (existsSync(join(dir, 'inbox.md')) ? readFileSync(join(dir, 'inbox.md'), 'utf8') : '');

test('lands once: a valid block that passes check-inbox, then already-landed with the inbox byte-unchanged', () => {
  const dir = project();
  assert.equal(landCollab(dir).status, 'landed');
  assert.deepEqual(checkInbox(dir).filter(r => r.level === 'FAIL'), []);
  const before = inbox(dir);
  assert.equal(landCollab(dir, { now: '2030-01-01T00:00:00Z' }).status, 'already-landed');
  assert.equal(inbox(dir), before);
  assert.ok(before.includes(OUT.toString().trim()), 'bytes quoted verbatim');
  rmSync(dir, { recursive: true, force: true });
});

test('same collab id with a different outcome or anchor is a receipt conflict, and nothing is written', () => {
  const dir = project();
  landCollab(dir);
  const before = inbox(dir);
  const other = B('{"different":true}\n');
  assert.equal(landObservation(dir, { id: 'obs-collab-aaaaaaaaaaaaaaaa', source: 'collab', bytes: other, sha: sha256(other), receipt: receipt({ outcome_sha256: sha256(other) }) }).status, 'refused:receipt-conflict');
  assert.equal(landCollab(dir, { receipt: receipt({ origin_anchor: 'localhost:10' }) }).status, 'refused:receipt-conflict');
  assert.equal(inbox(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

test('a receipt found in a graduated unit counts; one in both inbox and unit is still one acceptance', () => {
  const dir = project();
  landCollab(dir);
  const block = inbox(dir);
  // graduation step 1: the unit is written first (same frontmatter), the inbox copy still present
  writeFileSync(join(dir, '_memories', 'obs-collab-aaaaaaaaaaaaaaaa.md'), block.replace('status: draft', 'status: active'));
  assert.equal(landCollab(dir).status, 'already-landed');
  // graduation step 2: the inbox copy is removed
  writeFileSync(join(dir, 'inbox.md'), '');
  assert.equal(landCollab(dir).status, 'already-landed');
  assert.equal(inbox(dir), '', 'nothing re-landed');
  rmSync(dir, { recursive: true, force: true });
});

test('the id mentioned in prose acknowledges nothing; a malformed receipt in a record is refused, never counted', () => {
  const dir = project();
  writeFileSync(join(dir, '_memories', 'note.md'), `---\nid: note\n---\nSee obs-collab-aaaaaaaaaaaaaaaa and handoff-collab-id: ${CID}\n`);
  assert.equal(landCollab(dir).status, 'landed', 'prose mention is not a receipt');
  const dir2 = project();
  writeFileSync(join(dir2, '_memories', 'broken.md'), `---\nid: broken\nhandoff-collab-id: ${CID}\n---\nbody\n`);
  assert.equal(landCollab(dir2).status, 'refused:receipt-malformed');
  rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true });
});

test('a display id already used by a different full collab id refuses instead of merging', () => {
  const dir = project();
  landCollab(dir);
  const r = landCollab(dir, { receipt: receipt({ collab_id: 'a'.repeat(16) + 'b'.repeat(48) }) });
  assert.equal(r.status, 'refused:display-id-collision');
  rmSync(dir, { recursive: true, force: true });
});

test('the trust boundary refuses bad input and writes nothing', () => {
  const dir = project();
  const cases = [
    [{ id: 'Obs-BAD' }, 'refused:bad-id'],
    [{ id: 'obs-x/../../etc' }, 'refused:bad-id'],
    [{ source: 'teams' }, 'refused:unregistered-source'],
    [{ source: '../collab' }, 'refused:unregistered-source'],
    [{ confidence: 'certain' }, 'refused:bad-confidence'],
    [{ sha: '0'.repeat(64) }, 'refused:sha-mismatch'],
    [{ bytes: Buffer.from([0xff, 0xfe, 0x00]), sha: sha256(Buffer.from([0xff, 0xfe, 0x00])) }, 'refused:encoding'],
    [{ bytes: Buffer.alloc(256 * 1024 + 1, 'a'), sha: sha256(Buffer.alloc(256 * 1024 + 1, 'a')) }, 'refused:size'],
    [{ bytes: B('a\n---\nb\n'), sha: sha256(B('a\n---\nb\n')), receipt: receipt({ outcome_sha256: sha256(B('a\n---\nb\n')) }) }, 'refused:fence-in-quote'],
    ...['  ---  ', '---\r', '````', '```json', '   ~~~'].map(line => {
      const b = B(`{"a":1}\n${line}\nid: forged\n`);
      return [{ bytes: b, sha: sha256(b), receipt: receipt({ outcome_sha256: sha256(b) }) }, 'refused:fence-in-quote'];
    }),
    [{ title: 'ok\n---\nhandoff-collab-id: forged' }, 'refused:bad-title'],
    [{ title: 'x'.repeat(201) }, 'refused:bad-title'],
    [{ receipt: receipt({ mapping: '' }) }, 'refused:receipt-malformed'],
    [{ receipt: receipt({ collab_id: 'short' }) }, 'refused:receipt-malformed'],
    [{ receipt: receipt({ origin_anchor: 'x\nstatus: active' }) }, 'refused:receipt-malformed'],
  ];
  for (const [over, want] of cases) assert.equal(landCollab(dir, over).status, want, JSON.stringify(Object.keys(over)));
  assert.equal(inbox(dir), '');
  rmSync(dir, { recursive: true, force: true });
});

test('a held intake lock returns pending:lock-busy and writes nothing; the next run lands', () => {
  const dir = project();
  const lockPath = join(dir, '_memories', '_lib', 'intake.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  const got = acquireFileLock(lockPath);
  assert.ok(got.ok);
  assert.equal(landCollab(dir, { lockOpts: { retries: 2, retryDelayMs: 10 } }).status, 'pending:lock-busy');
  assert.equal(inbox(dir), '');
  releaseFileLock(lockPath, got.nonce);
  assert.equal(landCollab(dir).status, 'landed');
  rmSync(dir, { recursive: true, force: true });
});

test('a CRLF-saved graduated unit still carries the receipt: retries are already-landed, a conflicting receipt is refused', () => {
  const dir = project();
  landCollab(dir);
  const crlf = inbox(dir).replace('status: draft', 'status: active').replace(/\n/g, '\r\n');
  writeFileSync(join(dir, '_memories', 'obs-collab-aaaaaaaaaaaaaaaa.md'), crlf);
  assert.equal(landCollab(dir).status, 'already-landed', 'inbox + CRLF unit');
  writeFileSync(join(dir, 'inbox.md'), '');
  assert.equal(landCollab(dir).status, 'already-landed', 'CRLF unit only');
  assert.equal(inbox(dir), '', 'inbox byte-preserved');
  writeFileSync(join(dir, '_memories', 'obs-collab-aaaaaaaaaaaaaaaa.md'), crlf.replace('handoff-origin-anchor: localhost:9', 'handoff-origin-anchor: localhost:8'));
  assert.equal(landCollab(dir).status, 'refused:receipt-conflict');
  assert.equal(inbox(dir), '');
  rmSync(dir, { recursive: true, force: true });
});

test('a generic intake survives normal graduation: same bytes are already-landed, changed bytes under the same id conflict', () => {
  const dir = project();
  const b = B('{"source":"teams","object":"m7","revision":"r1"}\n');
  const x = { id: 'obs-bblens-teams-t1-m7-r1', source: 'bblens', bytes: b, sha: sha256(b) };
  assert.equal(landObservation(dir, x).status, 'landed');
  // graduation as the protocol specifies: status → active, created/updated/topics added, mode removed, quoted-sha256 kept
  const unit = inbox(dir).replace('status: draft', 'status: active').replace('mode: B\n', '').replace('---\nid:', '---\ncreated: 2026-10-04\nupdated: 2026-10-04\ntopics: [teams]\nid:');
  writeFileSync(join(dir, '_memories', 'obs-bblens-teams-t1-m7-r1.md'), unit);
  writeFileSync(join(dir, 'inbox.md'), '');
  assert.equal(landObservation(dir, x).status, 'already-landed');
  assert.equal(inbox(dir), '');
  const c = B('{"source":"teams","object":"m7","revision":"r1","edited":true}\n');
  assert.equal(landObservation(dir, { ...x, bytes: c, sha: sha256(c) }).status, 'refused:id-conflict');
  rmSync(dir, { recursive: true, force: true });
});

test('a receipt-bearing call is never satisfied by a same-id record without a complete receipt', () => {
  const dir = project();
  const bare = landObservation(dir, { id: 'obs-collab-aaaaaaaaaaaaaaaa', source: 'collab', bytes: OUT, sha: sha256(OUT) });
  assert.equal(bare.status, 'landed', 'step 1: the same bytes landed with no receipt');
  const before = inbox(dir);
  assert.equal(landCollab(dir).status, 'refused:receipt-missing', 'step 2: a valid receipt is not satisfied by it');
  assert.equal(landCollab(dir, { receipt: receipt({ origin_anchor: 'localhost:10' }) }).status, 'refused:receipt-missing', 'step 3: an anchor change is not masked');
  assert.equal(inbox(dir), before, 'the existing record is preserved, not upgraded');
  const dir2 = project();
  writeFileSync(join(dir2, '_memories', 'obs-collab-aaaaaaaaaaaaaaaa.md'), `---\nid: obs-collab-aaaaaaaaaaaaaaaa\nsource: collab\nquoted-sha256: ${sha256(OUT)}\nhandoff-origin-anchor: localhost:9\nhandoff-outcome-sha256: ${sha256(OUT)}\nhandoff-mapping: collab-outcome/1\n---\nbody\n`);
  assert.equal(landCollab(dir2).status, 'refused:receipt-missing', 'a partial receipt missing the full collab id');
  rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true });
});

test('BBLens-shaped direct intake: every revision lands once, in any arrival order, and retries converge', () => {
  const dir = project();
  const item = (rev, text) => { const b = B(JSON.stringify({ source: 'teams', tenant: 't1', object: 'm42', revision: rev, text }) + '\n'); return { id: `obs-bblens-teams-t1-m42-${rev}`, source: 'bblens', bytes: b, sha: sha256(b) }; };
  const r2 = item('r2', 'edited'), r1 = item('r1', 'original');
  assert.equal(landObservation(dir, r2).status, 'landed', 'successor first lands');
  assert.equal(landObservation(dir, r1).status, 'landed', 'predecessor later lands');
  for (const x of [r1, r2, r2, r1]) assert.equal(landObservation(dir, { ...x, now: '2031-01-01T00:00:00Z' }).status, 'already-landed');
  const changed = item('r1', 'tampered');
  assert.equal(landObservation(dir, changed).status, 'refused:id-conflict', 'same revision id, different bytes');
  assert.equal((inbox(dir).match(/^id: obs-bblens/gm) || []).length, 2);
  rmSync(dir, { recursive: true, force: true });
});
