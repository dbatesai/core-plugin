// Behavioral companion for the capability-probe runner: descriptor loading and
// harness detection against explicit env objects (never the ambient process.env),
// so the tests stay hermetic regardless of the harness running them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDescriptor,
  detectConsumingHarness,
  runStartup,
  SCHEMA_VERSION,
} from '../../plugins/core/skills/core/scripts/capability-probe.mjs';

test('loadDescriptor parses the shipped descriptor and SCHEMA_VERSION is 1.0.0', () => {
  assert.equal(SCHEMA_VERSION, '1.0.0');
  // No-arg call exercises the shipped default path (../schemas/ relative to the
  // script). loadDescriptor throws on a schema_version mismatch, so a clean
  // return already proves descriptor and runner agree.
  const descriptor = loadDescriptor();
  assert.equal(descriptor.schema_version, SCHEMA_VERSION);
  assert.ok(descriptor.harnesses && typeof descriptor.harnesses === 'object', 'harnesses map present');
  assert.ok('claude-code' in descriptor.harnesses, 'claude-code harness declared');
  assert.ok('codex' in descriptor.harnesses, 'codex harness declared');
});

test('detectConsumingHarness reads the passed env: claude-code and codex shapes', () => {
  assert.equal(detectConsumingHarness({ CLAUDE_PLUGIN_ROOT: '/x/plugins/core' }), 'claude-code');
  // Codex-shaped env — strong plugin-root signal plus the weak thread signal
  assert.equal(detectConsumingHarness({ CODEX_PLUGIN_ROOT: '/y/plugins/core', CODEX_THREAD_ID: 'thread-1' }), 'codex');
  // Weak-only signals still resolve the harness
  assert.equal(detectConsumingHarness({ CODEX_THREAD_ID: 'thread-1' }), 'codex');
  assert.equal(detectConsumingHarness({ CLAUDE_CODE_SESSION_ID: 'sess-1' }), 'claude-code');
});

test('an empty env falls back to the documented default: unknown', () => {
  // Per the detection-chain doc in capability-probe.mjs / resolve-plugin-root.mjs:
  // no signals → harness 'unknown' (source not_exposed).
  assert.equal(detectConsumingHarness({}), 'unknown');
  // Conflicting signals also degrade to unknown rather than guessing
  assert.equal(
    detectConsumingHarness({ CLAUDE_PLUGIN_ROOT: '/x', CODEX_PLUGIN_ROOT: '/y' }),
    'unknown'
  );
});

// --- An empty rowset is UNKNOWN, not a clean startup ---

test('an unknown harness yields one explicit UNKNOWN row, not silence', async () => {
  const r = await runStartup({ harness: 'no-such-harness', env: {}, cwd: '/tmp' });
  assert.equal(r.rows.length, 1, 'silence and "nothing to report" must not look the same');
  assert.equal(r.rows[0].identity_status, 'UNKNOWN');
  assert.equal(r.rows[0].capability_id, 'harness-capability-set');
  assert.equal(r.summary.unknown, 1);
  assert.equal(r.complete, false, 'the rowset does not cover the declared capabilities');
});

test('a harness declaring no capabilities is also UNKNOWN, with its own reason', async () => {
  const descriptor = { schema_version: SCHEMA_VERSION, harnesses: { 'bare': { capabilities: [] } } };
  const r = await runStartup({ harness: 'bare', descriptor, env: {}, cwd: '/tmp' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].identity_status, 'UNKNOWN');
  assert.equal(r.complete, false);
  assert.match(JSON.stringify(r.rows[0].evidence), /no-capabilities-declared/);
});

test('a harness with declared capabilities reports a complete rowset', async () => {
  const r = await runStartup({ harness: 'claude-code', env: { CLAUDE_PLUGIN_ROOT: '/x/plugins/core' }, cwd: '/tmp' });
  assert.equal(r.complete, true);
  assert.ok(r.rows.length >= 1);
});
