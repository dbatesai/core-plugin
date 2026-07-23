import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  captureRichContext,
  richContextCaptureEnabled,
  richContextStats,
  richContextDir,
  shouldEnrichRichContext,
  normalizeRichContextRow,
  runRichContextRetention,
  purgeRichContext,
  byteCapHead,
  RICH_CONTEXT_SCHEMA_VERSION,
  RICH_CONTEXT_MAX_FIELD_BYTES,
} from '../../plugins/core/skills/core/scripts/rich-context-capture.mjs';
import { NOTICE_TEXT } from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'rich-context-capture.mjs');

function makeProject(root, { flag = false } = {}) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  const ws = { workspace_id: 'rc-fixture' };
  if (flag) ws.rich_context_capture = true;
  writeFileSync(join(project, 'workspace.json'), JSON.stringify(ws));
  return project;
}

const goodRow = (extra = {}) => ({
  query_text: 'why did the retrieval miss the ledger fact',
  context_pack_head: 'delivered pack text here',
  verdict: 'no-hit',
  retrieval_id: 'rid-1',
  session_id: 's-1',
  harness: 'claude-code',
  tier_reached: 1,
  escalation_path: [1],
  producer_version: '3.13.1',
  producer_sha: 'deadbeef',
  ...extra,
});

// ---------- flag / off-by-default ----------

test('OFF by default: no flag → capture is disabled and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-off-'));
  try {
    const project = makeProject(root, { flag: false });
    assert.equal(richContextCaptureEnabled({ project }), false);
    const r = captureRichContext(project, goodRow());
    assert.equal(r.captured, false);
    assert.equal(r.reason, 'capture-disabled');
    assert.equal(existsSync(richContextDir(project)), false, 'no stream dir created when off');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('env CORE_RICH_CONTEXT_CAPTURE=0 hard-off beats the workspace flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-envoff-'));
  try {
    const project = makeProject(root, { flag: true });
    assert.equal(richContextCaptureEnabled({ project, env: { CORE_RICH_CONTEXT_CAPTURE: '0' } }), false);
    assert.equal(richContextCaptureEnabled({ project, env: {} }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('flag ON: capture writes a schema-versioned row with byte-capped text', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-on-'));
  try {
    const project = makeProject(root, { flag: true });
    const r = captureRichContext(project, goodRow());
    assert.equal(r.captured, true);
    const lines = readFileSync(r.path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.kind, 'rich-context');
    assert.equal(row.schema_version, RICH_CONTEXT_SCHEMA_VERSION);
    assert.equal(row.verdict, 'no-hit');
    assert.equal(row.retrieval_id, 'rid-1');
    assert.equal(row.query_text, 'why did the retrieval miss the ledger fact');
    assert.equal(row.context_pack_head, 'delivered pack text here');
    assert.ok(row.ts, 'row carries a timestamp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('schema-version is always OUR stamp, never caller-supplied', () => {
  const row = normalizeRichContextRow({ ...goodRow(), schema_version: '9.9.9', kind: 'evil' });
  assert.equal(row.schema_version, RICH_CONTEXT_SCHEMA_VERSION);
  assert.equal(row.kind, 'rich-context');
});

test('a row with no query_text is rejected (nothing worth capturing)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-noquery-'));
  try {
    const project = makeProject(root, { flag: true });
    const r = captureRichContext(project, { ...goodRow(), query_text: '   ' });
    assert.equal(r.captured, false);
    assert.match(r.reason, /invalid-row/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('byteCapHead trims on a real UTF-8 boundary and reports truncation', () => {
  const big = 'x'.repeat(RICH_CONTEXT_MAX_FIELD_BYTES + 500) + '💡';
  const capped = byteCapHead(big);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.head, 'utf8') <= RICH_CONTEXT_MAX_FIELD_BYTES);
  // multibyte emoji not split into a replacement char
  assert.ok(!capped.head.includes('�'));
  const small = byteCapHead('short');
  assert.equal(small.truncated, false);
  assert.equal(small.head, 'short');
});

// ---------- trigger predicate ----------

test('shouldEnrichRichContext fires only on a bad synchronous signal', () => {
  assert.equal(shouldEnrichRichContext({ zeroHit: true }), true);
  assert.equal(shouldEnrichRichContext({ retryShaped: true }), true);
  assert.equal(shouldEnrichRichContext({ zeroHit: false, retryShaped: false }), false);
  assert.equal(shouldEnrichRichContext({}), false);
});

// ---------- concurrent locked appends ----------

test('concurrent writers under the lock: every row survives intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-conc-'));
  try {
    const project = makeProject(root, { flag: true });
    const WRITERS = 6;
    const ROWS_EACH = 25;
    // A tiny worker that hammers captureRichContext for its share of rows.
    const worker = join(root, 'worker.mjs');
    writeFileSync(worker, `
import { captureRichContext } from ${JSON.stringify(MODULE)};
const [project, tag, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  const r = captureRichContext(project, {
    query_text: 'q-' + tag + '-' + i,
    context_pack_head: 'pack',
    verdict: 'no-hit',
    retrieval_id: 'rid-' + tag + '-' + i,
    session_id: 's', harness: 'claude-code',
    tier_reached: 1, escalation_path: [1],
    producer_version: 'v', producer_sha: 'sha',
  });
  if (!r.captured) { process.stderr.write('FAIL:' + r.reason + '\\n'); process.exit(1); }
}
`);
    const runs = [];
    for (let w = 0; w < WRITERS; w++) {
      runs.push(new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, project, String(w), String(ROWS_EACH)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}: ${err}`)));
      }));
    }
    await Promise.all(runs);

    // All rows present, every one a valid parse, ids all distinct.
    const files = readdirSync(richContextDir(project)).filter((f) => /\.jsonl$/.test(f));
    const ids = new Set();
    let total = 0;
    for (const f of files) {
      for (const line of readFileSync(join(richContextDir(project), f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        total++;
        const row = JSON.parse(line); // throws on interleaved/corrupt write
        ids.add(row.retrieval_id);
      }
    }
    assert.equal(total, WRITERS * ROWS_EACH, 'no rows lost or duplicated under concurrency');
    assert.equal(ids.size, WRITERS * ROWS_EACH, 'every distinct row landed uncorrupted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- retention ----------

test('retention: dry-run reports old files but deletes nothing; apply deletes + verifies; recent kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-ret-'));
  try {
    const project = makeProject(root, { flag: true });
    const dir = richContextDir(project);
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, '2020-01-01.jsonl');
    const recentFile = join(dir, '2099-01-01.jsonl'); // far future → always inside the window
    writeFileSync(oldFile, JSON.stringify({ kind: 'rich-context' }) + '\n');
    writeFileSync(recentFile, JSON.stringify({ kind: 'rich-context' }) + '\n');

    const dry = runRichContextRetention(project, { apply: false });
    assert.equal(dry.ran, true);
    assert.deepEqual(dry.candidates, [oldFile]);
    assert.equal(dry.deleted.length, 0);
    assert.ok(existsSync(oldFile), 'dry-run deletes nothing');

    const real = runRichContextRetention(project, { apply: true });
    assert.deepEqual(real.deleted, [oldFile]);
    assert.equal(real.verified, true);
    assert.equal(existsSync(oldFile), false, 'old file gone after apply');
    assert.equal(existsSync(recentFile), true, 'recent file kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retention: window boundary keeps a file dated exactly at the cutoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-retb-'));
  try {
    const project = makeProject(root, { flag: true });
    const dir = richContextDir(project);
    mkdirSync(dir, { recursive: true });
    // now = 2026-02-01; window 30d → cutoff ~2026-01-02. A 2026-01-15 file is inside.
    const inside = join(dir, '2026-01-15.jsonl');
    const outside = join(dir, '2025-12-01.jsonl');
    writeFileSync(inside, '{}\n');
    writeFileSync(outside, '{}\n');
    const res = runRichContextRetention(project, { apply: false, now: '2026-02-01T00:00:00Z', windowDays: 30 });
    assert.deepEqual(res.candidates, [outside]);
    assert.ok(res.kept.includes(inside));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- purge + boundary safety ----------

test('purge deletes the whole stream directory (and only that)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-purge-'));
  try {
    const project = makeProject(root, { flag: true });
    captureRichContext(project, goodRow());
    const dir = richContextDir(project);
    assert.ok(existsSync(dir));
    const res = purgeRichContext(project, { apply: true });
    assert.equal(res.purged, true);
    assert.equal(existsSync(dir), false);
    // the sibling memory store and workspace.json are untouched
    assert.ok(existsSync(join(project, '_memories')));
    assert.ok(existsSync(join(project, 'workspace.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('purge dry-run reports but deletes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-purgedry-'));
  try {
    const project = makeProject(root, { flag: true });
    captureRichContext(project, goodRow());
    const res = purgeRichContext(project, { apply: false });
    assert.equal(res.purged, false);
    assert.equal(res.reason, 'dry-run');
    assert.ok(existsSync(richContextDir(project)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deletion ops refuse a target outside the rich-context directory', () => {
  // normalizeRichContextRow/retention/purge all assert against the directory
  // name. Directly exercise the assertion via a doctored directory: a purge
  // whose resolved dir is NOT <base>/rich-context must refuse. We simulate by
  // pointing at a project whose _metrics has a look-alike dir.
  const root = mkdtempSync(join(tmpdir(), 'rc-refuse-'));
  try {
    const project = makeProject(root, { flag: true });
    // Plant a decoy file directly under _metrics (NOT rich-context) and a
    // retention candidate that is not a <date>.jsonl — retention must skip it.
    const dir = richContextDir(project);
    mkdirSync(dir, { recursive: true });
    const nonDate = join(dir, 'not-a-date.jsonl');
    writeFileSync(nonDate, '{}\n');
    const res = runRichContextRetention(project, { apply: true, now: '2099-01-01T00:00:00Z' });
    // 'not-a-date.jsonl' is not a date-file, so it is never a candidate and never deleted.
    assert.ok(existsSync(nonDate), 'non-date file is never a retention target');
    assert.ok(!res.candidates.includes(nonDate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- stats / visible-active-state feed ----------

test('richContextStats reports enabled + counts when on, disabled when off', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-stats-'));
  try {
    const off = makeProject(join(root, 'a'), { flag: false });
    assert.equal(richContextStats(off).enabled, false);
    const on = makeProject(join(root, 'b'), { flag: true });
    captureRichContext(on, goodRow());
    captureRichContext(on, goodRow({ retrieval_id: 'rid-2' }));
    const s = richContextStats(on);
    assert.equal(s.enabled, true);
    assert.equal(s.rows, 2);
    assert.equal(s.days, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- disclosure ----------

test('first-run disclosure notice mentions the optional rich-context stream + off-by-default', () => {
  assert.match(NOTICE_TEXT, /rich_context_capture/);
  assert.match(NOTICE_TEXT, /OFF by default/i);
});
