import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';

// Codex-shaped product-path tests (UserPromptSubmit). These exercise the Codex
// wrapper entry file exactly as hooks-codex.json invokes it — real subprocess
// spawns, real payload shapes per the documented Codex contract (session_id) —
// not the shared implementation's internals directly. What these CANNOT prove:
// that a live Codex install actually delivers this payload shape or sets
// PLUGIN_ROOT in a hook subprocess's env. That's a separate on-harness step.

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks');
const RETRIEVE_HOOK = join(HOOKS_DIR, 'retrieve-context-hook-codex.mjs');

// Rooted under ~/.core (fix, 2026-07-18): CORE_HOOKS_LOG_FILE now only
// honors overrides inside the trusted ~/.core. Unlike os.tmpdir(), that dir
// isn't auto-cleaned — every created dir is tracked and removed below.
const _isolatedLogDirs = [];
function isolatedHooksLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'codex-hook-log-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });

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

test('Codex wrapper: UserPromptSubmit hook writes NO pending marker — the outcome closer is retired', () => {
  // The retrieval door stages no per-turn pending state: an automatic outcome
  // pipeline that can only ever record usefulness:"unknown" answers nothing.
  const root = makeStore(mkdtempSync(join(tmpdir(), 'codex-hook-')));
  try {
    runRetrieveHook('widget decision', { payload: { cwd: root, session_id: 'codex-sess-1' } });
    const lib = join(root, '_memories', '_lib');
    const pendings = existsSync(lib) ? readdirSync(lib).filter(f => f.startsWith('pending-retrieval-')) : [];
    assert.equal(pendings.length, 0, 'no pending marker: the outcome-closer pipeline is deleted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hooks-codex.json: registers UserPromptSubmit pointing at the Codex wrapper file, using ${PLUGIN_ROOT}, and no other event', () => {
  const manifest = JSON.parse(readFileSync(join(HOOKS_DIR, '..', '..', '..', 'hooks', 'hooks-codex.json'), 'utf8'));
  assert.ok(manifest.hooks.UserPromptSubmit, 'UserPromptSubmit registered');
  const upsCmd = manifest.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(upsCmd, /\$\{PLUGIN_ROOT\}.*retrieve-context-hook-codex\.mjs/);
  assert.deepEqual(Object.keys(manifest.hooks), ['UserPromptSubmit'],
    'the per-turn retrieval door is the only Codex hook registration');
});

test('codex.md hook prose names exactly the events hooks-codex.json registers (manifest-to-prose)', () => {
  // The adapter doc's registration sentence must be derived from the manifest,
  // not remembered: parse hooks-codex.json, then require the prose sentence
  // "`hooks/hooks-codex.json` registers ... only" to name exactly the
  // registered event set — no extra event, no missing event.
  const manifest = JSON.parse(readFileSync(join(HOOKS_DIR, '..', '..', '..', 'hooks', 'hooks-codex.json'), 'utf8'));
  const registered = Object.keys(manifest.hooks || {}).sort();
  const adapter = readFileSync(join(HOOKS_DIR, '..', 'harnesses', 'codex.md'), 'utf8');
  const sentence = adapter.match(/`hooks\/hooks-codex\.json` registers ((?:`\w+`(?:,\s*| and )?)+) only/);
  assert.ok(sentence, 'codex.md must state what hooks-codex.json registers');
  const claimed = [...sentence[1].matchAll(/`(\w+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(claimed, registered,
    `codex.md claims [${claimed}] but hooks-codex.json registers [${registered}]`);
});

test('.codex-plugin/plugin.json registers hooks-codex.json explicitly (not relying on the automatic-discovery default)', () => {
  const manifest = JSON.parse(readFileSync(join(HOOKS_DIR, '..', '..', '..', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks, './hooks/hooks-codex.json');
});

// ---- Import-boundary fail-open: the Codex wrapper's
// `await import(...)` must sit INSIDE a try/catch, so a resolution/syntax failure in the
// shared implementation cannot throw at the top level and exit non-zero — before main()'s own
// entry guard ever runs. A hook must never break the user's exit on failure. Reproduced by
// copying the wrapper next to a deliberately broken target module under the same
// relative filename the wrapper imports.
function runBrokenWrapper(wrapperName, targetName) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-wrapper-broken-'));
  try {
    const wrapperSrc = readFileSync(join(HOOKS_DIR, wrapperName), 'utf8');
    writeFileSync(join(dir, wrapperName), wrapperSrc);
    // Syntax error, not just a throw — proves the *import/resolution* step itself is
    // covered, not only a runtime exception inside a successfully-imported module.
    writeFileSync(join(dir, targetName), 'export function main( {{{ syntax error\n');
    return execFileSync('node', [join(dir, wrapperName)], {
      input: JSON.stringify({ cwd: dir, session_id: 'broken-import-probe' }),
      env: { ...process.env, CORE_HOOKS_LOG_FILE: isolatedHooksLog() },
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Codex UserPromptSubmit wrapper: a broken shared module still exits 0 (fail-open covers the import, not just main())', () => {
  assert.doesNotThrow(() => runBrokenWrapper('retrieve-context-hook-codex.mjs', 'retrieve-context-hook.mjs'),
    'a SyntaxError in the imported module must not propagate as a non-zero exit');
});
