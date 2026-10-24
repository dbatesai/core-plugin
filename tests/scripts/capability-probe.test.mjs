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

// --out replaces the shell redirect startup used to write capability-state.json:
// one plain `node … --out <file>` is what a permission rule can match; `>` asks.
test('CLI: --startup --out writes the JSON to the file and prints one summary line', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'capability-probe.mjs');
  const { mkdirSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'cap-out-'));
  try {
    const hot = join(home, 'proj', '_core', 'claude-code');
    mkdirSync(hot, { recursive: true });
    const out = join(hot, 'capability-state.json');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--startup', '--json', '--out', out], {
      cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.ok(existsSync(out), 'file written into the existing _core state folder');
    const json = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(json.mode, 'startup');
    assert.match(stdout, /capability-probe \(mode=startup/);
    assert.ok(!stdout.includes('"rows"'), 'the JSON goes to the file, not stdout');
    assert.ok(!existsSync(`${out}.${process.pid}.tmp`), 'no temp file left behind');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI: --out without a path is a usage error', async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'capability-probe.mjs');
  const r = spawnSync(process.execPath, [SCRIPT, '--startup', '--out'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out requires a file path/);
});

// The call runs pre-approved under the skill's allowed-tools, so --out is confined:
// an existing <project>/_core/<harness>/ folder and the fixed file name, nothing else.
test('CLI: --out outside a _core state folder, or with another name, is refused before any write', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'capability-probe.mjs');
  const home = mkdtempSync(join(tmpdir(), 'cap-out-refuse-'));
  try {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, 'proj', '_core', 'claude-code'), { recursive: true });
    const cases = [
      join(home, '.claude', 'settings.json'),                        // a settings file: outside any _core folder
      join(home, 'proj', '_core', 'claude-code', 'other.json'),      // right folder, wrong name
      join(home, 'proj', '_core', 'missing', 'capability-state.json'), // parent folder does not exist
    ];
    for (const out of cases) {
      const r = spawnSync(process.execPath, [SCRIPT, '--startup', '--out', out], { cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      assert.equal(r.status, 2, `${out}: exit 2`);
      assert.match(r.stderr, /--out must be an existing <project>\/_core\/<harness>\/capability-state\.json/);
      assert.ok(!existsSync(out), `${out}: nothing written`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
