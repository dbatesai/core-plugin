import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPackage } from '../../plugins/core/skills/core/scripts/metrics-package.mjs';
import { captureRichContext } from '../../plugins/core/skills/core/scripts/rich-context-capture.mjs';

// PERMANENT canary tripwire (Hale metrics-evidence contract, product-item 2 +
// implementation-item 4): the rich-context capture stream must be STRUCTURALLY
// unreachable by the package exporter. A canary string is planted in a real
// captured rich-context row; the built package bytes must never contain it.
const CANARY = 'RICHCTX-CANARY-do-not-export-a1b2c3d4e5';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');

function makeProject(root) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'rc-canary-ws', rich_context_capture: true }));
  writeFileSync(join(project, 'PROJECT.md'), '# P\n');
  writeFileSync(join(store, 'dc-1.md'), '---\nid: dc-1\ntype: decision\nstatus: active\ncreated: 2026-06-01\n---\n\nBody.\n');
  const sessions = join(project, '_sessions', '2026-07-01');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'retrieval-log.jsonl'),
    JSON.stringify({ kind: 'retrieval', ts: '2026-07-01T10:00:00Z', intent_topics: ['a'], tier_reached: 1, units_retrieved: [{ id: 'dc-1', tier: 1 }] }) + '\n');
  return project;
}

function makeHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  mkdirSync(join(home, 'Desktop'), { recursive: true });
  return home;
}

function readShipped(shipped, dest) {
  if (shipped.kind === 'folder') return shipped.path;
  mkdirSync(dest, { recursive: true });
  spawnSync('tar', ['-x', '-f', basename(shipped.path), '-C', dest], { cwd: dirname(shipped.path), encoding: 'utf8' });
  return dest;
}

function readAll(dir) {
  let text = '';
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else text += readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return text;
}

test('exporter never emits rich-context content (planted canary tripwire)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-canary-'));
  try {
    const project = makeProject(root);
    const home = makeHome(root);
    // Capture a real rich-context row carrying the canary in its query text.
    // force:true bypasses the per-user opt-in gate (which now lives in the
    // machine-local manifest, not this project pointer) — this canary test is
    // about exporter isolation, not the opt-in resolution, so it plants a row
    // unconditionally.
    const cap = captureRichContext(project, {
      query_text: `debug this: ${CANARY}`,
      context_pack_head: `context with ${CANARY} inside`,
      verdict: 'no-hit', retrieval_id: 'rid-x', session_id: 's', harness: 'claude-code',
      tier_reached: 1, escalation_path: [1], producer_version: 'v', producer_sha: 'sha',
    }, { force: true });
    assert.equal(cap.captured, true, 'canary row captured into the rich-context stream');
    // Confirm the canary really is on disk under _metrics/rich-context (so a
    // negative package result means true isolation, not a mis-plant).
    assert.match(readFileSync(cap.path, 'utf8'), new RegExp(CANARY));

    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    const text = readAll(readShipped(result.shipped, join(root, 'x')));
    assert.ok(!text.includes(CANARY), 'rich-context content must never reach an exported package');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('metrics-package.mjs source has no read path into the rich-context stream', () => {
  const src = readFileSync(join(SCRIPTS, 'metrics-package.mjs'), 'utf8');
  assert.ok(!src.includes('rich-context'), 'exporter source must not reference the rich-context directory at all');
  assert.ok(!src.includes('rich_context_capture'), 'exporter must not read the rich-context flag');
});
