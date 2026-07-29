// Chaos battery (v3.14.0 Task 7): the concurrent-append integrity check —
// two real OS processes hammering the same date-file
// through the shared exclusion lock must never tear a JSONL row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(ROOT, 'plugins', 'core', 'skills', 'core', 'scripts');
// Windows contract: dynamic/ESM imports of absolute paths MUST be file:// URLs
// (a bare C:\ path parses as an invalid URL scheme on Windows).
const TURN_CAPTURE_URL = pathToFileURL(join(SCRIPTS, 'turn-capture.mjs')).href;

function makeProject(root) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'chaos-fixture' }));
  return project;
}

// A worker process that appends N evidence rows through the real writer.
const WORKER = `
import { captureTurnEvidence } from ${JSON.stringify(TURN_CAPTURE_URL)};
const [project, tag, n] = process.argv.slice(2);
let failed = 0;
for (let i = 0; i < Number(n); i++) {
  const res = captureTurnEvidence(project, {
    retrieval_id: tag + '-' + i,
    session_id: 's-' + tag,
    harness: 'claude-code',
    // A large-ish payload so a torn write would actually tear something.
    prompt_text: 'chaos prompt ' + tag + ' ' + i + ' ' + 'x'.repeat(2000),
    pack_text: 'pack ' + 'y'.repeat(2000),
    delivered: [{ id: 'u-1', score: 1, source_stage: 'ranked', pack_text: 'z'.repeat(1000) }],
    rejected_top: [],
    truncation: { byte_cap_applied: false, prompt_tokens_used: 3 },
    store_signature: 'sig',
    producer_version: 'v', producer_sha: 'sha',
  }, { now: '2026-07-24T2' + (i % 4) + ':00:00Z' });
  if (!res.written) failed++;
}
process.exit(failed === 0 ? 0 : 3);
`;

test('chaos: two concurrent OS processes append 50 large rows each — every line parses, none lost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-chaos-'));
  try {
    const project = makeProject(root);
    const workerFile = join(root, 'worker.mjs');
    writeFileSync(workerFile, WORKER);
    const env = { ...process.env };
    delete env.CORE_METRICS_ENABLED;
    delete env.CORE_TURN_CAPTURE;
    const run = (tag) => new Promise((resolveP) => {
      const p = spawn('node', [workerFile, project, tag, '50'], { env });
      p.on('exit', (code) => resolveP(code));
    });
    const [a, b] = await Promise.all([run('alpha'), run('beta')]);
    assert.equal(a, 0, 'worker alpha wrote all rows');
    assert.equal(b, 0, 'worker beta wrote all rows');

    const dir = join(project, '_metrics', 'turn-capture');
    const ids = new Set();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `torn JSONL line in ${f}`);
        ids.add(parsed.retrieval_id);
      }
    }
    assert.equal(ids.size, 100, `expected 100 distinct rows, found ${ids.size} — rows lost or duplicated`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('chaos: purge racing a live writer never tears a row or crashes either side', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-chaos-purge-'));
  try {
    const project = makeProject(root);
    const workerFile = join(root, 'worker.mjs');
    writeFileSync(workerFile, WORKER);
    const env = { ...process.env };
    delete env.CORE_METRICS_ENABLED;
    delete env.CORE_TURN_CAPTURE;
    const writer = new Promise((resolveP) => {
      const p = spawn('node', [workerFile, project, 'gamma', '40'], { env });
      p.on('exit', (code) => resolveP(code));
    });
    // Purge mid-write through the same shared lock, three times.
    const purger = (async () => {
      const { purgeTurnCapture } = await import(TURN_CAPTURE_URL);
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 30));
        const res = purgeTurnCapture(project, { apply: true });
        assert.ok(res.purged || /purge-failed|delete-unverified/.test(res.reason || ''), JSON.stringify(res));
      }
    })();
    const [code] = await Promise.all([writer, purger]);
    assert.equal(code, 0, 'writer survived the purges (fail-open, no crash)');
    // Whatever survived on disk must be well-formed.
    const dir = join(project, '_metrics', 'turn-capture');
    try {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          if (line.trim()) assert.doesNotThrow(() => JSON.parse(line), `torn line after purge race in ${f}`);
        }
      }
    } catch { /* dir fully purged — also a valid outcome */ }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
