import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

function runHook(prompt, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt }),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('default OFF: flag unset → no output, exit 0', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '', CORE_RETRIEVAL_STORE: FIXT });
  assert.equal(out.trim(), '', 'hook must be a no-op when CORE_RETRIEVAL_HOOK is not 1');
});

test('flag ON: injects summaries for a known query', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  assert.match(out, /want-omega-speedmaster-on-sale-wait/, 'the literal-match want should be injected');
});

test('flag ON but empty query → no crash, exit 0', () => {
  const out = runHook('', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  assert.equal(typeof out, 'string');
});

test('output is byte-capped', () => {
  const out = runHook('watch chronograph omega speedmaster heritage agenda', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2048, 'injected context must stay within the byte cap');
});

test('integration: bootstrap integrity marker + hook injection coexist under a combined cap', async () => {
  const { checkContextIntegrity } = await import('../../plugins/core/skills/core/scripts/check-context-integrity.mjs');
  const marker = checkContextIntegrity({ memoryBytes: 1000, projectTotalLines: 100, projectReadLines: 100 }).marker;
  const injected = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  const combined = marker + '\n' + injected;
  assert.match(combined, /CONTEXT-COMPLETE/);
  assert.match(combined, /want-omega-speedmaster-on-sale-wait/);
  assert.ok(Buffer.byteLength(combined, 'utf8') <= 4096, 'startup marker + per-turn injection together stay bounded');
});
