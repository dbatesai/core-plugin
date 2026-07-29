import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPackage } from '../../plugins/core/skills/core/scripts/metrics-package.mjs';
import { captureTurnEvidence } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

// PERMANENT canary tripwire (v3.14.0 Link 1, inheriting the rich-context
// stream's contract): the turn-capture evidence stream must be STRUCTURALLY
// unreachable by the package exporter. A canary string is planted in a real
// captured evidence row; the built package bytes must never contain it.
const CANARY = 'TURNCAP-CANARY-do-not-export-f6e5d4c3b2';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');

function makeProject(root) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'tc-canary-ws' }));
  writeFileSync(join(project, 'PROJECT.md'), '# P\n');
  writeFileSync(join(store, 'dc-1-alpha.md'), '---\nid: dc-1-alpha\ntype: decision\nstatus: active\ncreated: 2026-06-01\n---\n\nBody.\n');
  const sessions = join(project, '_sessions', '2026-07-01');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'retrieval-log.jsonl'),
    JSON.stringify({ kind: 'retrieval', ts: '2026-07-01T10:00:00Z', intent_topics: ['a'], tier_reached: 1, units_retrieved: [{ id: 'dc-1-alpha', tier: 1 }] }) + '\n');
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

test('exporter never emits turn-capture evidence content (planted canary tripwire)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-canary-'));
  try {
    const project = makeProject(root);
    const home = makeHome(root);
    // Capture a real evidence row carrying the canary in prompt AND pack text
    // (default-ON stream — no force flag needed).
    const env = { ...process.env };
    delete env.CORE_METRICS_ENABLED;
    delete env.CORE_TURN_CAPTURE;
    const cap = captureTurnEvidence(project, {
      retrieval_id: 'rid-x',
      session_id: 's',
      harness: 'claude-code',
      prompt_text: `debug this: ${CANARY}`,
      pack_text: `context with ${CANARY} inside`,
      delivered: [{ id: 'dc-1-alpha', score: 1, source_stage: 'ranked', pack_text: `unit text ${CANARY}` }],
      rejected_top: [],
      truncation: { byte_cap_applied: false, prompt_tokens_used: 3 },
      store_signature: 'sig',
      producer_version: 'v',
      producer_sha: 'sha',
    }, { env });
    assert.equal(cap.written, true, `canary row captured into the turn-capture stream: ${cap.reason}`);
    // Confirm the canary really is on disk (so a negative package result means
    // true isolation, not a mis-plant).
    assert.match(readFileSync(cap.path, 'utf8'), new RegExp(CANARY));

    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    const text = readAll(readShipped(result.shipped, join(root, 'x')));
    assert.ok(!text.includes(CANARY), 'turn-capture evidence must never reach an exported package');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('metrics-package.mjs source has no read path into the turn-capture stream', () => {
  const src = readFileSync(join(SCRIPTS, 'metrics-package.mjs'), 'utf8');
  assert.ok(!src.includes('turn-capture'), 'exporter source must not reference the turn-capture directory at all');
  assert.ok(!src.includes('turn_capture'), 'exporter must not read the turn-capture flag');
});
