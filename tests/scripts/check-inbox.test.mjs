import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../plugins/core/skills/core/scripts/check-inbox.mjs');

// import() needs a file:// URL — a bare drive-letter path throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows.
const { parseInboxBlocks, checkInbox } = await import(pathToFileURL(SCRIPT).href);

function makeProject({ inbox, units = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-inbox-'));
  mkdirSync(join(dir, '_memories', 'observations', '2026-06'), { recursive: true });
  if (inbox !== undefined) writeFileSync(join(dir, 'inbox.md'), inbox);
  for (const u of units) writeFileSync(join(dir, '_memories', `${u}.md`), `---\nid: ${u}\n---\nbody\n`);
  return dir;
}

const VALID_B_BLOCK = `---
id: obs-teams-20260609-budget-shift
type: observation
status: draft
source: teams-chat
source-instance: msg-4471
extracted-at: 2026-06-09T10:00:00Z
confidence-level: inferred
mode: B
topics: [budget]
---
Budget owner shifted the Q3 line to infra. Mentioned in the weekly sync thread.
`;

const VALID_C_BLOCK = `---
id: obs-jira-20260609-date-conflict
type: observation
status: draft
source: jira
source-instance: PROJ-991
extracted-at: 2026-06-09T11:00:00Z
confidence-level: reconstructed
mode: C
judgment-needed: contradicts dc-42 on the BGL date — confirm which is authoritative
---
Reconstructed from three comments: the BGL date moved to Aug 1.
`;

test('parseInboxBlocks extracts frontmatter and body', () => {
  const blocks = parseInboxBlocks(VALID_B_BLOCK + '\n' + VALID_C_BLOCK);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].fm.mode, 'B');
  assert.match(blocks[0].body, /Budget owner shifted/);
  assert.equal(blocks[1].fm['judgment-needed'].startsWith('contradicts dc-42'), true);
});

test('valid Mode B + Mode C blocks pass with no FAIL/WARN', () => {
  const dir = makeProject({ inbox: VALID_B_BLOCK + '\n' + VALID_C_BLOCK });
  const report = checkInbox(dir);
  assert.deepEqual(report.filter((r) => r.level !== 'INFO'), []);
  rmSync(dir, { recursive: true, force: true });
});

test('missing required field is a FAIL naming the field', () => {
  const broken = VALID_B_BLOCK.replace('extracted-at: 2026-06-09T10:00:00Z\n', '');
  const dir = makeProject({ inbox: broken });
  const fails = checkInbox(dir).filter((r) => r.level === 'FAIL' && r.check === 'required-field');
  assert.equal(fails.length, 1);
  assert.match(fails[0].detail, /extracted-at/);
  rmSync(dir, { recursive: true, force: true });
});

test('invalid mode value is a FAIL', () => {
  const dir = makeProject({ inbox: VALID_B_BLOCK.replace('mode: B', 'mode: D') });
  assert.equal(checkInbox(dir).some((r) => r.level === 'FAIL' && r.check === 'mode-value'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('Mode C without judgment-needed is a FAIL', () => {
  const broken = VALID_C_BLOCK.replace(/judgment-needed: .*\n/, '');
  const dir = makeProject({ inbox: broken });
  assert.equal(checkInbox(dir).some((r) => r.level === 'FAIL' && r.check === 'judgment-needed'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('invalid confidence-level is a FAIL', () => {
  const dir = makeProject({ inbox: VALID_B_BLOCK.replace('confidence-level: inferred', 'confidence-level: guessed') });
  assert.equal(checkInbox(dir).some((r) => r.level === 'FAIL' && r.check === 'confidence-value'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('ratified stability-class on an inbox block is a FAIL (graduation-only field)', () => {
  const broken = VALID_B_BLOCK.replace('topics: [budget]', 'stability-class: durably-correct');
  const dir = makeProject({ inbox: broken });
  assert.equal(checkInbox(dir).some((r) => r.level === 'FAIL' && r.check === 'graduation-field'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('proposed-stability-class is allowed', () => {
  const ok = VALID_B_BLOCK.replace('topics: [budget]', 'proposed-stability-class: durably-suspect');
  const dir = makeProject({ inbox: ok });
  assert.equal(checkInbox(dir).some((r) => r.check === 'graduation-field'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('duplicate id across two blocks is a FAIL', () => {
  const dir = makeProject({ inbox: VALID_B_BLOCK + '\n' + VALID_B_BLOCK });
  assert.equal(checkInbox(dir).some((r) => r.level === 'FAIL' && r.check === 'duplicate-id'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('status: active on an inbox block is a WARN, id collision with store is a WARN', () => {
  const active = VALID_B_BLOCK.replace('status: draft', 'status: active');
  const dir = makeProject({ inbox: active, units: ['obs-teams-20260609-budget-shift'] });
  const report = checkInbox(dir);
  assert.equal(report.some((r) => r.level === 'WARN' && r.check === 'status-active'), true);
  assert.equal(report.some((r) => r.level === 'WARN' && r.check === 'id-collision'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('untagged frontmatter block (no mode) is INFO only', () => {
  const untagged = `---\nid: loose-note\ntype: observation\n---\nFree-form note dropped in by hand.\n`;
  const dir = makeProject({ inbox: untagged });
  const report = checkInbox(dir);
  assert.equal(report.filter((r) => r.level === 'FAIL').length, 0);
  assert.equal(report.some((r) => r.level === 'INFO' && r.check === 'untagged-block'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('missing or empty inbox.md exits 0', () => {
  const dir = makeProject({});
  const out = execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.match(out, /no inbox/i);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI exit codes: 2 on FAIL, 0 on clean, and --json emits valid JSON', () => {
  const clean = makeProject({ inbox: VALID_B_BLOCK });
  const out = execFileSync(process.execPath, [SCRIPT, clean, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.equal(Array.isArray(parsed.report), true);
  rmSync(clean, { recursive: true, force: true });

  const broken = makeProject({ inbox: VALID_B_BLOCK.replace('mode: B', 'mode: Z') });
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, broken], { encoding: 'utf8' }),
    (err) => err.status === 2,
  );
  rmSync(broken, { recursive: true, force: true });
});
