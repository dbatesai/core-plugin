import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, '../../plugins/core/skills/core/scripts');
const { graduateInboxBlock } = await import(pathToFileURL(join(SCRIPTS, 'graduate-inbox-block.mjs')).href);
const { landObservation, sha256 } = await import(pathToFileURL(join(SCRIPTS, 'land-observation.mjs')).href);
const { parseFlatFrontmatter } = await import(pathToFileURL(join(SCRIPTS, 'frontmatter-flat.mjs')).href);

const HOME = mkdtempSync(join(tmpdir(), 'grad-home-'));   // the state cache the creation stamp writes
process.env.HOME = HOME;
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'grad-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  mkdirSync(join(dir, '_sources'), { recursive: true });
  writeFileSync(join(dir, '_sources', 'collab.yaml'), 'name: collab\n');
  writeFileSync(join(dir, '_sources', 'bblens.yaml'), 'name: bblens\n');
  return dir;
}
const OUT = Buffer.from('{"close":{"event_id":"evt-9"},"schema":"collab-outcome/1","slug":"s"}\n');
const R = { collab_id: 'c'.repeat(64), origin_anchor: 'localhost:9', outcome_sha256: sha256(OUT), mapping: 'collab-outcome/1' };
const ID = 'obs-collab-cccccccccccccccc';
const land = (dir) => landObservation(dir, { id: ID, source: 'collab', bytes: OUT, sha: sha256(OUT), receipt: R, now: '2026-10-04T05:00:00Z' });
const inbox = (dir) => (existsSync(join(dir, 'inbox.md')) ? readFileSync(join(dir, 'inbox.md'), 'utf8') : '');

test('graduation writes the unit with identity and receipt intact, removes the block, and intake stays already-landed', () => {
  const dir = project();
  const other = landObservation(dir, { id: 'obs-bblens-x-r1', source: 'bblens', bytes: Buffer.from('{"r":1}\n'), sha: sha256(Buffer.from('{"r":1}\n')) });
  assert.equal(other.status, 'landed');
  assert.equal(land(dir).status, 'landed');
  const r = graduateInboxBlock(dir, { id: ID, set: { topics: '[collab]' }, now: '2026-10-04T06:00:00Z' });
  assert.equal(r.status, 'graduated');
  const [fm] = parseFlatFrontmatter(readFileSync(r.path, 'utf8'));
  assert.equal(fm.status, 'active');
  assert.equal(fm.mode, undefined, 'inbox-only field dropped');
  for (const k of ['handoff-collab-id', 'handoff-origin-anchor', 'handoff-outcome-sha256', 'handoff-mapping', 'quoted-sha256', 'source']) assert.ok(fm[k], `${k} carried`);
  assert.ok(readFileSync(r.path, 'utf8').includes(OUT.toString().trim()), 'quoted bytes carried');
  assert.ok(!inbox(dir).includes(ID), 'block removed');
  assert.ok(inbox(dir).includes('obs-bblens-x-r1'), 'the other block is untouched');
  assert.equal(land(dir).status, 'already-landed');
  assert.equal(graduateInboxBlock(dir, { id: ID }).status, 'already-graduated');
  rmSync(dir, { recursive: true, force: true });
});

test('a crash between the unit write and the block removal leaves both, never zero; intake counts one; the rerun finishes', () => {
  const dir = project();
  land(dir);
  const fault = { renameSync: () => { const e = new Error('crash'); e.code = 'EIO'; throw e; } };
  const r1 = graduateInboxBlock(dir, { id: ID, fsOps: fault, now: '2026-10-04T06:00:00Z' });
  assert.equal(r1.status, 'pending:inbox-write-failed');
  assert.ok(existsSync(r1.path), 'unit written');
  assert.ok(inbox(dir).includes(ID), 'block still present');
  const unitBytes = readFileSync(r1.path, 'utf8');
  assert.equal(land(dir).status, 'already-landed', 'two copies are one acceptance');
  const r2 = graduateInboxBlock(dir, { id: ID, now: '2026-10-04T07:00:00Z' });
  assert.equal(r2.status, 'graduated-resumed');
  assert.equal(readFileSync(r2.path, 'utf8'), unitBytes, 'unit not rewritten');
  assert.ok(!inbox(dir).includes(ID));
  rmSync(dir, { recursive: true, force: true });
});

test('identity fields cannot be overridden; a different unit already at the path is refused; a mode-C resolution is recorded', () => {
  const dir = project();
  land(dir);
  for (const k of ['id', 'source', 'quoted-sha256', 'handoff-collab-id', 'mode']) assert.equal(graduateInboxBlock(dir, { id: ID, set: { [k]: 'x' } }).status, 'refused:immutable-field', k);
  assert.equal(graduateInboxBlock(dir, { id: ID, set: { topics: 'a\nstatus: retired' } }).status, 'refused:bad-override');
  const path = join(dir, '_memories', 'observations', '2026-10', `${ID}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nid: ${ID}\nsource: collab\nhandoff-collab-id: ${'d'.repeat(64)}\n---\nsomething else\n`);
  assert.equal(graduateInboxBlock(dir, { id: ID }).status, 'refused:unit-conflict');
  assert.ok(inbox(dir).includes(ID), 'block kept when refused');
  rmSync(path);
  const r = graduateInboxBlock(dir, { id: ID, resolution: 'Sourced beats inferred; kept the newer anchor.' });
  assert.equal(r.status, 'graduated');
  assert.match(readFileSync(r.path, 'utf8'), /## Resolution\n\nSourced beats inferred/);
  rmSync(dir, { recursive: true, force: true });
});

test('a unit with the same header but a different body is a conflict; neither file changes and the source stays', () => {
  const dir = project();
  land(dir);
  const before = inbox(dir);
  const path = join(dir, '_memories', 'observations', '2026-10', `${ID}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const header = before.split('\n---\n')[0].replace('status: draft', 'status: active').replace('mode: B\n', '');
  const other = `${header}\n---\nDIFFERENT BODY\n`;
  writeFileSync(path, other);
  assert.equal(graduateInboxBlock(dir, { id: ID }).status, 'refused:unit-conflict');
  assert.equal(readFileSync(path, 'utf8'), other);
  assert.equal(inbox(dir), before, 'the only copy of the source bytes is kept');
  rmSync(dir, { recursive: true, force: true });
});

test('a failed creation stamp keeps the inbox copy; the retry stamps the verified unit and finishes', async () => {
  const { createFile, classifyFileLifecycle } = await import(pathToFileURL(join(SCRIPTS, 'lifecycle-detect.mjs')).href);
  const dir = project();
  land(dir);
  const create = (p, path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return { stamped: false, outcome: 'attribution-unknown', recovery: 'recovery-required', reason: 'LOCK_HELD' }; };
  const r1 = graduateInboxBlock(dir, { id: ID, create, now: '2026-10-04T06:00:00Z' });
  assert.equal(r1.status, 'pending:baseline-failed');
  assert.equal(r1.detail, 'LOCK_HELD');
  assert.ok(inbox(dir).includes(ID), 'inbox obligation retained');
  assert.equal(classifyFileLifecycle(dir, r1.path, { kind: 'unit' }).classification, 'no-baseline');
  const r2 = graduateInboxBlock(dir, { id: ID });
  assert.equal(r2.status, 'graduated-resumed');
  assert.notEqual(classifyFileLifecycle(dir, r2.path, { kind: 'unit' }).classification, 'no-baseline', 'now stamped');
  assert.ok(!inbox(dir).includes(ID));
  rmSync(dir, { recursive: true, force: true });
});

test('a plain land → graduate with no overrides yields a unit that passes the store schema', async () => {
  const { checkSchema } = await import(pathToFileURL(join(SCRIPTS, 'check-units.mjs')).href);
  const { loadUnit } = await import(pathToFileURL(join(SCRIPTS, 'priority.mjs')).href);
  const dir = project();
  land(dir);
  const r = graduateInboxBlock(dir, { id: ID });
  assert.equal(r.status, 'graduated');
  const report = [];
  checkSchema([loadUnit(r.path)], join(dir, '_memories'), report);
  assert.deepEqual(report.filter(x => x.level === 'FAIL'), []);
  rmSync(dir, { recursive: true, force: true });
});

test('a retry in a later month finds the unit in its original month', () => {
  const dir = project();
  landObservation(dir, { id: ID, source: 'collab', bytes: OUT, sha: sha256(OUT), receipt: R, now: '2026-09-30T05:00:00Z' });
  const r = graduateInboxBlock(dir, { id: ID, now: '2026-10-01T06:00:00Z' });
  assert.match(r.path, /observations[\\/]2026-09[\\/]/);
  assert.equal(graduateInboxBlock(dir, { id: ID, now: '2026-10-01T07:00:00Z' }).status, 'already-graduated');
  rmSync(dir, { recursive: true, force: true });
});

test('resume refuses an existing unit that is invalid or malformed; both files stay unchanged', () => {
  for (const [name, mutate, want] of [
    ['missing topics', (t) => t.replace(/^topics: .*\n/m, ''), 'refused:invalid-unit'],
    ['unmatched edges marker', (t) => t + '\n<!-- CORE:BEGIN_EDGES -->\n', 'refused:unit-malformed'],
  ]) {
    const dir = project();
    land(dir);
    const fault = { renameSync: () => { const e = new Error('crash'); e.code = 'EIO'; throw e; } };
    const r1 = graduateInboxBlock(dir, { id: ID, fsOps: fault, create: (_p, path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, mutate(text)); return { stamped: false, reason: 'test' }; } });
    assert.equal(r1.status, 'pending:baseline-failed', name);
    const unitBefore = readFileSync(r1.path, 'utf8'), inboxBefore = inbox(dir);
    const r2 = graduateInboxBlock(dir, { id: ID });
    assert.equal(r2.status, want, name);
    assert.equal(readFileSync(r1.path, 'utf8'), unitBefore, `${name}: unit unchanged`);
    assert.equal(inbox(dir), inboxBefore, `${name}: inbox obligation kept`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup', () => { rmSync(HOME, { recursive: true, force: true }); });
