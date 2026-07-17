import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Codex-shaped product-path tests (Hale's fresh audit, 2026-07-17, second
// round: "add Codex-shaped UserPromptSubmit/Stop product-path tests"). These
// exercise the Codex wrapper entry files exactly as hooks-codex.json invokes
// them — real subprocess spawns, real payload shapes per the documented
// Codex contract (session_id + turn_id) — not the shared implementation's
// internals directly. What these CANNOT prove: that a live Codex install
// actually delivers this payload shape, fires Stop once per turn, or sets
// PLUGIN_ROOT in a hook subprocess's env. That's Hale's/Crest's step.

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks');
const RETRIEVE_HOOK = join(HOOKS_DIR, 'retrieve-context-hook-codex.mjs');
const ANSWER_HOOK = join(HOOKS_DIR, 'answer-close-hook-codex.mjs');

function isolatedHooksLog() {
  return join(mkdtempSync(join(tmpdir(), 'codex-hook-log-')), 'hooks-log.jsonl');
}

function makeStore(root) {
  const store = join(root, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(root, 'PROJECT.md'), '# T\n');
  writeFileSync(join(store, 'dc-1-widget.md'), '---\nid: dc-1-widget\ntype: decision\nstatus: active\ncreated: 2026-07-01\ntopics:\n  - widget\n---\n\nWidget decision body.\n');
  return root;
}

function runRetrieveHook(prompt, env) {
  return execFileSync('node', [RETRIEVE_HOOK], {
    input: JSON.stringify({ prompt, ...env.payload }),
    env: {
      ...process.env,
      CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_PLUGIN_ROOT: undefined,
      CORE_METRICS_ENABLED: '1', CORE_HOOKS_LOG_FILE: isolatedHooksLog(),
      ...env,
    },
    encoding: 'utf8',
  });
}

function runAnswerHook(payload, env) {
  return execFileSync('node', [ANSWER_HOOK], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_PLUGIN_ROOT: undefined,
      CORE_HOOKS_LOG_FILE: isolatedHooksLog(),
      ...env,
    },
    encoding: 'utf8',
  });
}

function readOutcomeRows(root) {
  const sess = join(root, '_sessions');
  if (!existsSync(sess)) return [];
  const rows = [];
  for (const d of readdirSync(sess)) {
    const f = join(sess, d, 'outcome-log.jsonl');
    if (existsSync(f)) for (const l of readFileSync(f, 'utf8').trim().split('\n')) if (l) rows.push(JSON.parse(l));
  }
  return rows.filter(r => r.kind === 'retrieval-outcome');
}

test('Codex wrapper: UserPromptSubmit hook writes a pending marker tagged harness=codex', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'codex-hook-')));
  try {
    runRetrieveHook('widget decision', { payload: { cwd: root, session_id: 'codex-sess-1' } });
    const lib = join(root, '_memories', '_lib');
    const pendings = existsSync(lib) ? readdirSync(lib).filter(f => f.startsWith('pending-retrieval-')) : [];
    assert.equal(pendings.length, 1, 'a pending marker was written');
    const marker = JSON.parse(readFileSync(join(lib, pendings[0]), 'utf8'));
    assert.equal(marker.harness, 'codex', 'harness is explicit codex, not inferred from ambient env');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex wrapper: Stop hook closes the pending retrieval using turn_id as answer_turn_id, never prompt_id or retrieval_id', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'codex-hook-')));
  try {
    runRetrieveHook('widget decision', { payload: { cwd: root, session_id: 'codex-sess-2' } });
    runAnswerHook({ cwd: root, session_id: 'codex-sess-2', turn_id: 'real-codex-turn-abc123', prompt_id: 'must-be-ignored-not-a-codex-field' }, {});
    const rows = readOutcomeRows(root);
    assert.equal(rows.length, 1, 'exactly one outcome row for the closed retrieval');
    const row = rows[0];
    assert.equal(row.harness, 'codex');
    assert.equal(row.session_id, 'codex-sess-2');
    assert.equal(row.answer_turn_id, 'real-codex-turn-abc123', 'uses the Codex-native turn_id, not the Claude-shaped prompt_id field even when present');
    assert.notEqual(row.answer_turn_id, row.retrieval_id, 'never aliases retrieval_id');
    assert.equal(row.usefulness_outcome, 'unknown');
    assert.equal(row.evidence_authority, 'unobservable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex wrapper: falls back to a fresh id (never retrieval_id) when turn_id is absent', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'codex-hook-')));
  try {
    runRetrieveHook('widget decision', { payload: { cwd: root, session_id: 'codex-sess-3' } });
    runAnswerHook({ cwd: root, session_id: 'codex-sess-3' }, {});
    const rows = readOutcomeRows(root);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].answer_turn_id, rows[0].retrieval_id);
    assert.match(rows[0].answer_turn_id, /^[0-9a-f-]{36}$/i, 'fallback is a fresh UUID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex and Claude Code sessions with the same session_id never cross-close each other (harness is part of the key)', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'codex-hook-')));
  try {
    // A Claude-Code-shaped pending marker for the SAME session_id string.
    const claudeHook = join(HOOKS_DIR, 'retrieve-context-hook.mjs');
    execFileSync('node', [claudeHook], {
      input: JSON.stringify({ prompt: 'widget decision', cwd: root, session_id: 'shared-id' }),
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_PLUGIN_ROOT: undefined,
        CLAUDECODE: '1', CORE_METRICS_ENABLED: '1', CORE_HOOKS_LOG_FILE: isolatedHooksLog(),
      },
      encoding: 'utf8',
    });
    // A Codex-shaped Stop for the SAME session_id must not touch the Claude marker.
    runAnswerHook({ cwd: root, session_id: 'shared-id', turn_id: 'codex-turn-x' }, {});
    assert.equal(readOutcomeRows(root).length, 0, 'Codex Stop must not close a Claude-Code-harness pending marker sharing the same session id string');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hooks-codex.json: registers UserPromptSubmit and Stop pointing at the Codex wrapper files, using ${PLUGIN_ROOT}', () => {
  const manifest = JSON.parse(readFileSync(join(HOOKS_DIR, '..', '..', '..', 'hooks', 'hooks-codex.json'), 'utf8'));
  assert.ok(manifest.hooks.UserPromptSubmit, 'UserPromptSubmit registered');
  assert.ok(manifest.hooks.Stop, 'Stop registered');
  const upsCmd = manifest.hooks.UserPromptSubmit[0].hooks[0].command;
  const stopCmd = manifest.hooks.Stop[0].hooks[0].command;
  assert.match(upsCmd, /\$\{PLUGIN_ROOT\}.*retrieve-context-hook-codex\.mjs/);
  assert.match(stopCmd, /\$\{PLUGIN_ROOT\}.*answer-close-hook-codex\.mjs/);
});

test('.codex-plugin/plugin.json registers hooks-codex.json explicitly (not relying on the automatic-discovery default)', () => {
  const manifest = JSON.parse(readFileSync(join(HOOKS_DIR, '..', '..', '..', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks, './hooks/hooks-codex.json');
});
