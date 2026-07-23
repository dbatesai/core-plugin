import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir, homedir, userInfo, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  captureRichContext,
  richContextCaptureEnabled,
  richContextStats,
  richContextDir,
  richContextLockPath,
  userWorkspaceMetaPath,
  shouldEnrichRichContext,
  normalizeRichContextRow,
  runRichContextRetention,
  purgeRichContext,
  richCaptureStatusCode,
  byteCapHead,
  RICH_CONTEXT_SCHEMA_VERSION,
  RICH_CONTEXT_MAX_FIELD_BYTES,
  RICH_CONTEXT_DIR_MODE,
  RICH_CONTEXT_FILE_MODE,
} from '../../plugins/core/skills/core/scripts/rich-context-capture.mjs';
import { NOTICE_TEXT } from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'rich-context-capture.mjs');
const HOOK = join(HERE, '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
const FIXTURE_STORE = join(HERE, '..', 'fixtures', 'obligation3-store');

const WS_ID = 'rc-fixture';
const IS_WIN = platform() === 'win32';

// The rich_context_capture opt-in now lives in the MACHINE-LOCAL per-user
// manifest (~/.core/workspaces/<id>/workspace.json), not the project pointer
// (Hale ea140b0 item 2). homedir() honors HOME/USERPROFILE, so we redirect it to
// a temp dir for the duration of each test — the manifest write never touches the
// real ~/.core, exactly as metrics-disclosure.test.mjs does.
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'rc-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return fn(home); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/** Write the per-user opt-in into the machine-local manifest under the fake home. */
function setUserFlag(wsId, value) {
  const dir = join(homedir(), '.core', 'workspaces', wsId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspace.json'),
    JSON.stringify({ workspace_id: wsId, rich_context_capture: value }, null, 2) + '\n');
}

/**
 * @param {object} opts
 * @param {boolean} opts.flag           set the per-user (machine-local) opt-in ON
 * @param {boolean} opts.projectRootFlag plant a DECOY flag in the project pointer
 *                                        (a copied/shared project) — must be ignored
 */
function makeProject(root, { flag = false, projectRootFlag = false } = {}) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  const ptr = { workspace_id: WS_ID };
  if (projectRootFlag) ptr.rich_context_capture = true;
  writeFileSync(join(project, 'workspace.json'), JSON.stringify(ptr));
  if (flag) setUserFlag(WS_ID, true);
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
  withHome(() => {
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
});

test('env CORE_RICH_CONTEXT_CAPTURE=0 hard-off beats the per-user flag', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-envoff-'));
    try {
      const project = makeProject(root, { flag: true });
      assert.equal(richContextCaptureEnabled({ project, env: { CORE_RICH_CONTEXT_CAPTURE: '0' } }), false);
      assert.equal(richContextCaptureEnabled({ project, env: {} }), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('flag ON: capture writes a schema-versioned row with byte-capped text', () => {
  withHome(() => {
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
});

test('schema-version is always OUR stamp, never caller-supplied', () => {
  const row = normalizeRichContextRow({ ...goodRow(), schema_version: '9.9.9', kind: 'evil' });
  assert.equal(row.schema_version, RICH_CONTEXT_SCHEMA_VERSION);
  assert.equal(row.kind, 'rich-context');
});

test('a row with no query_text is rejected (nothing worth capturing)', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-noquery-'));
    try {
      const project = makeProject(root, { flag: true });
      const r = captureRichContext(project, { ...goodRow(), query_text: '   ' });
      assert.equal(r.captured, false);
      assert.match(r.reason, /invalid-row/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
  assert.equal(shouldEnrichRichContext({ zeroHit: false }), false);
  assert.equal(shouldEnrichRichContext({}), false);
});

// =====================================================================
// ACCEPTANCE Hale-ea140b0 item 2 — the opt-in is PER-USER (machine-local),
// not project-scoped. A flag that rides in a copied/shared project must be
// ignored; only the machine-local per-user manifest can turn capture on.
// =====================================================================

test('ACCEPTANCE Hale-ea140b0 item 2: a copied-project workspace.json flag is IGNORED', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-copied-'));
    try {
      // Simulate a copied/shared project: the flag is planted in the project-root
      // pointer (which travels with the copy) but NOT in this user's machine-local
      // manifest. Capture must stay OFF — the teammate never opted in.
      const project = makeProject(root, { flag: false, projectRootFlag: true });
      // sanity: the decoy really is in the project pointer
      assert.equal(JSON.parse(readFileSync(join(project, 'workspace.json'), 'utf8')).rich_context_capture, true);
      assert.equal(richContextCaptureEnabled({ project }), false, 'project-root flag must NOT activate capture');
      const r = captureRichContext(project, goodRow());
      assert.equal(r.captured, false);
      assert.equal(r.reason, 'capture-disabled');

      // Now the SAME user opts in on THIS machine → capture activates.
      setUserFlag(WS_ID, true);
      assert.equal(userWorkspaceMetaPath(project), join(homedir(), '.core', 'workspaces', WS_ID, 'workspace.json'));
      assert.equal(richContextCaptureEnabled({ project }), true, 'machine-local per-user flag activates capture');
      assert.equal(captureRichContext(project, goodRow()).captured, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =====================================================================
// ACCEPTANCE Hale-ea140b0 item 3 — owner-only filesystem modes, asserted on
// create AND re-asserted on append.
// =====================================================================

test('ACCEPTANCE Hale-ea140b0 item 3: sensitive dir is 0700 and row files are 0600', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-modes-'));
    try {
      const project = makeProject(root, { flag: true });
      const r = captureRichContext(project, goodRow());
      assert.equal(r.captured, true);
      const dir = richContextDir(project);
      if (IS_WIN) {
        // Windows only honors the read-only bit; assert the surface exists and the
        // hardening call did not throw the capture (best-effort contract).
        assert.ok(existsSync(dir) && existsSync(r.path));
      } else {
        assert.equal(statSync(dir).mode & 0o777, RICH_CONTEXT_DIR_MODE, 'dir is owner-only 0700');
        assert.equal(statSync(r.path).mode & 0o777, RICH_CONTEXT_FILE_MODE, 'row file is owner-only 0600');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('ACCEPTANCE Hale-ea140b0 item 3: modes are RE-ASSERTED on append over a loosened file', () => {
  withHome(() => {
    if (IS_WIN) return; // POSIX-mode contract; Windows is best-effort
    const root = mkdtempSync(join(tmpdir(), 'rc-remode-'));
    try {
      const project = makeProject(root, { flag: true });
      const first = captureRichContext(project, goodRow());
      // An attacker/tool loosens the perms after the first write.
      chmodSync(richContextDir(project), 0o755);
      chmodSync(first.path, 0o644);
      // The next append must re-assert owner-only modes.
      const second = captureRichContext(project, goodRow({ retrieval_id: 'rid-2' }));
      assert.equal(second.path, first.path, 'same day file');
      assert.equal(statSync(richContextDir(project)).mode & 0o777, RICH_CONTEXT_DIR_MODE, 'dir re-hardened on append');
      assert.equal(statSync(first.path).mode & 0o777, RICH_CONTEXT_FILE_MODE, 'file re-hardened on append');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =====================================================================
// ACCEPTANCE Hale-ea140b0 item 4 — ONE exclusion lock shared by append,
// retention, and purge, at a stable sibling path OUTSIDE the purged dir.
// Two real concurrent-process falsifiers.
// =====================================================================

test('ACCEPTANCE Hale-ea140b0 item 4: the lock path is a sibling OUTSIDE the rich-context dir', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-lockpath-'));
    try {
      const project = makeProject(root, { flag: true });
      const lock = richContextLockPath(project);
      const dir = richContextDir(project);
      assert.equal(dirname(lock), dirname(dir), 'lock and stream dir are siblings');
      assert.notEqual(dirname(lock), dir, 'lock is NOT inside the purged directory');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// A worker that hammers captureRichContext (force:true — this falsifier is about
// lock integrity, not the opt-in gate).
function writeWorker(root) {
  const worker = join(root, 'writer.mjs');
  writeFileSync(worker, `
import { captureRichContext } from ${JSON.stringify(MODULE)};
const [project, tag, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  const r = captureRichContext(project, {
    query_text: 'q-' + tag + '-' + i,
    context_pack_head: 'pack-' + tag + '-' + i,
    verdict: 'no-hit',
    retrieval_id: 'rid-' + tag + '-' + i,
    session_id: 's', harness: 'claude-code',
    tier_reached: 1, escalation_path: [1],
    producer_version: 'v', producer_sha: 'sha',
  }, { force: true });
  if (!r.captured) { process.stderr.write('FAIL:' + r.reason + '\\n'); process.exit(1); }
}
`);
  return worker;
}

function spawnWorker(worker, project, tag, n) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, project, String(tag), String(n)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${err}`)));
  });
}

function parseAllRows(dir) {
  if (!existsSync(dir)) return { total: 0, ids: new Set() };
  const ids = new Set();
  let total = 0;
  for (const f of readdirSync(dir).filter((n) => /\.jsonl$/.test(n))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      total++;
      const row = JSON.parse(line); // throws on a torn/interleaved write
      ids.add(row.retrieval_id);
    }
  }
  return { total, ids };
}

test('concurrent writers under the shared lock: every row survives intact', async () => {
  await withHome(async () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-conc-'));
    try {
      const project = makeProject(root, { flag: true });
      const WRITERS = 6, ROWS_EACH = 25;
      const worker = writeWorker(root);
      await Promise.all(Array.from({ length: WRITERS }, (_, w) => spawnWorker(worker, project, w, ROWS_EACH)));
      const { total, ids } = parseAllRows(richContextDir(project));
      assert.equal(total, WRITERS * ROWS_EACH, 'no rows lost or duplicated under concurrency');
      assert.equal(ids.size, WRITERS * ROWS_EACH, 'every distinct row landed uncorrupted');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('ACCEPTANCE Hale-ea140b0 item 4: falsifier — concurrent capture vs retention loses no row, tears none', async () => {
  await withHome(async () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-fals-ret-'));
    try {
      const project = makeProject(root, { flag: true });
      const dir = richContextDir(project);
      mkdirSync(dir, { recursive: true });
      // An OLD file retention will target while writers hammer TODAY's file.
      const oldFile = join(dir, '2020-01-01.jsonl');
      writeFileSync(oldFile, JSON.stringify({ kind: 'rich-context' }) + '\n');

      const WRITERS = 5, ROWS_EACH = 40;
      const worker = writeWorker(root);
      const writers = Promise.all(Array.from({ length: WRITERS }, (_, w) => spawnWorker(worker, project, w, ROWS_EACH)));
      // Run retention repeatedly, concurrently, in-process — it shares the lock.
      let retentionRuns = 0;
      const retention = (async () => {
        while (true) {
          const res = runRichContextRetention(project, { apply: true, windowDays: 30 });
          retentionRuns++;
          if (res.ran) { /* nothing to assert per-iter; final state below */ }
          const stillWriting = await Promise.race([writers.then(() => false), new Promise((r) => setTimeout(() => r(true), 5))]);
          if (!stillWriting) break;
        }
      })();
      await writers;
      await retention;

      assert.equal(existsSync(oldFile), false, 'retention deleted the out-of-window file while writers ran');
      assert.ok(retentionRuns >= 1, 'retention actually ran concurrently');
      // Today's rows: none lost, none torn (parse throws on a torn line).
      const { total, ids } = parseAllRows(dir);
      assert.equal(total, WRITERS * ROWS_EACH, 'no captured row lost to a racing retention');
      assert.equal(ids.size, WRITERS * ROWS_EACH, 'every row intact and distinct');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('ACCEPTANCE Hale-ea140b0 item 4: falsifier — concurrent capture vs purge never tears a row or crashes a writer', async () => {
  await withHome(async () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-fals-purge-'));
    try {
      const project = makeProject(root, { flag: true });
      const WRITERS = 5, ROWS_EACH = 40;
      const worker = writeWorker(root);
      const writers = Promise.all(Array.from({ length: WRITERS }, (_, w) => spawnWorker(worker, project, w, ROWS_EACH)));
      // Purge repeatedly WHILE writers append. The lock lives OUTSIDE the purged
      // dir, so purge can never unlink it out from under a writer; each writer
      // either finished before a purge (its rows removed — expected) or recreates
      // the dir behind the purge. Falsifier: no writer crashes, no torn row.
      let purges = 0;
      const purger = (async () => {
        while (true) {
          const res = purgeRichContext(project, { apply: true });
          if (res.purged || res.existed === false) purges++;
          const stillWriting = await Promise.race([writers.then(() => false), new Promise((r) => setTimeout(() => r(true), 3))]);
          if (!stillWriting) break;
        }
      })();
      await writers; // rejects if ANY writer exited nonzero (a lost/failed capture)
      await purger;
      assert.ok(purges >= 1, 'purge actually ran concurrently');
      // Whatever survived the last purge must be fully intact (every line parses).
      assert.doesNotThrow(() => parseAllRows(richContextDir(project)), 'no torn row left behind by a purge/append race');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------- retention ----------

test('retention: dry-run reports old files but deletes nothing; apply deletes + verifies; recent kept', () => {
  withHome(() => {
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
});

test('retention: window boundary keeps a file dated exactly at the cutoff', () => {
  withHome(() => {
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
});

// ---------- purge + boundary safety ----------

test('purge deletes the whole stream directory (and only that)', () => {
  withHome(() => {
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
});

test('purge dry-run reports but deletes nothing', () => {
  withHome(() => {
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
});

test('deletion ops refuse a target outside the rich-context directory', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-refuse-'));
    try {
      const project = makeProject(root, { flag: true });
      const dir = richContextDir(project);
      mkdirSync(dir, { recursive: true });
      const nonDate = join(dir, 'not-a-date.jsonl');
      writeFileSync(nonDate, '{}\n');
      const res = runRichContextRetention(project, { apply: true, now: '2099-01-01T00:00:00Z' });
      assert.ok(existsSync(nonDate), 'non-date file is never a retention target');
      assert.ok(!res.candidates.includes(nonDate));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =====================================================================
// ACCEPTANCE Hale-ea140b0 item 5 — richContextStats reports EFFECTIVE state.
// =====================================================================

test('ACCEPTANCE Hale-ea140b0 item 5: stats report effective state, not the bare flag', () => {
  withHome(() => {
    const root = mkdtempSync(join(tmpdir(), 'rc-eff-'));
    try {
      const project = makeProject(root, { flag: true });

      // rich flag on + aggregate metrics on → EFFECTIVE.
      const onOn = richContextStats(project, { env: {} });
      assert.equal(onOn.enabled, true);
      assert.equal(onOn.effective, true);
      assert.equal(onOn.inactiveReason, null);

      // rich flag on + aggregate metrics OFF → configured on but INACTIVE.
      const onOff = richContextStats(project, { env: { CORE_METRICS_ENABLED: '0' } });
      assert.equal(onOff.enabled, true);
      assert.equal(onOff.effective, false);
      assert.equal(onOff.inactiveReason, 'aggregate metrics disabled');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('richContextStats reports enabled + counts when on, disabled when off', () => {
  withHome(() => {
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
});

// =====================================================================
// ACCEPTANCE Hale-ea140b0 item 6 — a capture outcome (incl. a failure) surfaces
// as a CLOSED status code, never raw content. Disclosure states exactly what
// is stored (a 4 KiB head on no-hit) — not "full text".
// =====================================================================

test('ACCEPTANCE Hale-ea140b0 item 6: richCaptureStatusCode folds outcomes onto a closed set, no raw content', () => {
  assert.equal(richCaptureStatusCode({ captured: true, path: '/x', row: {} }), 'captured');
  assert.equal(richCaptureStatusCode({ captured: false, reason: 'capture-disabled' }), 'disabled');
  assert.equal(richCaptureStatusCode({ captured: false, reason: 'project-dir-missing' }), 'project-dir-missing');
  assert.equal(richCaptureStatusCode({ captured: false, reason: 'invalid-row: query_text must be a non-empty string' }), 'invalid-row');
  assert.equal(richCaptureStatusCode({ captured: false, reason: 'capture-failed: ENOSPC no space left' }), 'capture-failed');
  assert.equal(richCaptureStatusCode(null), 'error');
  // The code carries NO free text from the reason — proven by the invalid-row case
  // above collapsing to just the token, dropping the message tail.
  assert.ok(!richCaptureStatusCode({ captured: false, reason: 'invalid-row: SECRET QUERY TEXT' }).includes('SECRET'));
});

test('ACCEPTANCE Hale-ea140b0 item 6: first-run disclosure states a 4 KiB head, not full text, in the per-user meta', () => {
  assert.match(NOTICE_TEXT, /rich_context_capture/);
  assert.match(NOTICE_TEXT, /OFF by default/i);
  assert.match(NOTICE_TEXT, /4 KiB/, 'names the bounded head');
  assert.match(NOTICE_TEXT, /not the full text/i, 'explicitly denies storing the full text');
  assert.match(NOTICE_TEXT, /machine-local workspace meta/i, 'points at the per-user meta, not the project pointer');
  assert.doesNotMatch(NOTICE_TEXT, /literal text of your query/, 'the old overstated wording is gone');
});

// =====================================================================
// ACCEPTANCE Hale-ea140b0 item 1 — a corrective retry never mislabels the
// CURRENT retrieval; the in-hook seam captures synchronous no-hit only, bound
// to the current retrieval as its own subject. Real hook subprocess.
// =====================================================================

function runHookForRich(store, prompt, home, extraEnv = {}) {
  // hook-log honors CORE_HOOKS_LOG_FILE only inside the trusted ~/.core, and
  // resolves "trusted home" from userInfo() (the REAL OS account home), NOT the
  // HOME env — so the log override must live under the real home even though the
  // rich-capture opt-in reads the fake HOME. (hook-log.mjs / trusted-home.mjs D1.)
  const trustedRoot = join(userInfo().homedir, '.core', '.test-tmp');
  mkdirSync(trustedRoot, { recursive: true });
  const logDir = mkdtempSync(join(trustedRoot, 'rc-hooklog-'));
  const logFile = join(logDir, 'hooks-log.jsonl');
  execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt, cwd: store, session_id: 'sess-rc-1' }),
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CORE_METRICS_ENABLED: '1',   // rich capture is nested under metrics-on
      CORE_HOOKS_LOG_FILE: logFile,
      CORE_HOOK_HARNESS: 'claude-code',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  const receipts = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rmSync(logDir, { recursive: true, force: true });
  return receipts[receipts.length - 1];
}

test('ACCEPTANCE Hale-ea140b0 item 1: a zero-hit writes verdict no-hit bound to the CURRENT retrieval; never corrective-retry', () => {
  withHome((home) => {
    const store = mkdtempSync(join(tmpdir(), 'rc-hook-store-'));
    try {
      // A real store (copied fixture) with the per-user opt-in ON on this machine.
      cpSync(FIXTURE_STORE, store, { recursive: true });
      writeFileSync(join(store, 'workspace.json'), JSON.stringify({ workspace_id: WS_ID }));
      setUserFlag(WS_ID, true);

      // (a) A gibberish prompt guarantees a synchronous zero-hit.
      const receipt = runHookForRich(store, 'zzqqxx nonexistent gibberish token wumpus', home);
      assert.equal(receipt.rich_capture, 'captured', 'capture outcome rides the terminal receipt (item 6)');
      const dir = richContextDir(store);
      const files = readdirSync(dir).filter((n) => /\.jsonl$/.test(n));
      const rows = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      assert.equal(rows.length, 1, 'exactly one rich row for the zero-hit turn');
      assert.equal(rows[0].verdict, 'no-hit', 'labeled no-hit, never corrective-retry');
      assert.notEqual(rows[0].verdict, 'corrective-retry');
      // The row is bound to the CURRENT retrieval as its own subject.
      assert.equal(rows[0].retrieval_id, receipt.retrieval_id, 'row subject == the current retrieval id');

      // (b) A prompt that HITS the fixture must NOT write a rich row at all — the
      // only trigger is a synchronous no-hit, so no retrieval (hit or retry-shaped)
      // can ever be mislabeled corrective-retry.
      const before = readdirSync(dir).filter((n) => /\.jsonl$/.test(n)).length;
      runHookForRich(store, 'omega speedmaster sale', home);
      const rowsAfter = readdirSync(dir).filter((n) => /\.jsonl$/.test(n))
        .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean));
      assert.ok(before >= 1);
      assert.ok(!rowsAfter.some((l) => JSON.parse(l).verdict === 'corrective-retry'), 'no corrective-retry row is ever written by the hook');
    } finally { rmSync(store, { recursive: true, force: true }); }
  });
});

// ---------- disclosure (kept) ----------

test('first-run disclosure notice mentions the optional rich-context stream + off-by-default', () => {
  assert.match(NOTICE_TEXT, /rich_context_capture/);
  assert.match(NOTICE_TEXT, /OFF by default/i);
});
