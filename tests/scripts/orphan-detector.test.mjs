import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findOrphans, formatReport, ALLOWLIST } from '../../plugins/core/skills/core/scripts/orphan-detector.mjs';

// Build a throwaway plugin tree: <root>/skills/core/{SKILL.md,scripts,protocols}.
function withPlugin(fn) {
  const root = mkdtempSync(join(tmpdir(), 'orphan-'));
  const core = join(root, 'skills', 'core');
  const scripts = join(core, 'scripts');
  const probes = join(scripts, 'capability');
  const protocols = join(core, 'protocols');
  for (const d of [scripts, probes, protocols, join(core, 'schemas')]) mkdirSync(d, { recursive: true });

  // SKILL.md indexes only good-protocol.md, and names wired.mjs in prose.
  writeFileSync(join(core, 'SKILL.md'),
    '# core\nRun `protocols/good-protocol.md`. Invoke `scripts/wired.mjs` at startup.\n');
  writeFileSync(join(core, 'protocols', 'good-protocol.md'), '# good\n');
  writeFileSync(join(core, 'protocols', 'bad-protocol.md'), '# orphan protocol (not indexed)\n');

  // wired.mjs imports helper.mjs (helper is transitively wired).
  writeFileSync(join(scripts, 'wired.mjs'), "import { h } from './helper.mjs';\nexport const x = h;\n");
  writeFileSync(join(scripts, 'helper.mjs'), 'export const h = 1;\n');
  writeFileSync(join(scripts, 'orphan.mjs'), 'export const nope = 1;\n'); // nothing reaches it
  writeFileSync(join(scripts, 'staged.mjs'), 'export const staged = 1;\n'); // allowlisted
  // A capability probe reached only via a descriptor .json delegate field.
  writeFileSync(join(probes, 'a-probe.mjs'), 'export const p = 1;\n');
  writeFileSync(join(core, 'schemas', 'descriptor.json'),
    JSON.stringify({ caps: [{ delegate: 'capability/a-probe.mjs' }] }, null, 2));

  try { return fn({ root, scripts, protocols }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const ALLOW = { 'staged.mjs': 'deliberately staged — pending decision X' };

test('findOrphans: flags the unreached script and the unindexed protocol', () => {
  withPlugin(({ root }) => {
    const r = findOrphans({ coreRoot: root, allowlist: ALLOW });
    assert.ok(r.orphanScripts.some((s) => s.endsWith('orphan.mjs')), 'orphan.mjs is an orphan');
    assert.ok(r.orphanProtocols.some((p) => p.endsWith('bad-protocol.md')), 'bad-protocol.md is unindexed');
  });
});

test('findOrphans: a prose-named script and its imported helper are both wired', () => {
  withPlugin(({ root }) => {
    const r = findOrphans({ coreRoot: root, allowlist: ALLOW });
    assert.ok(!r.orphanScripts.some((s) => s.endsWith('wired.mjs')), 'wired.mjs is named in SKILL.md');
    assert.ok(!r.orphanScripts.some((s) => s.endsWith('helper.mjs')), 'helper.mjs is transitively wired via import');
  });
});

test('findOrphans: a probe reached only via a .json delegate is wired (not a false orphan)', () => {
  withPlugin(({ root }) => {
    const r = findOrphans({ coreRoot: root, allowlist: ALLOW });
    assert.ok(!r.orphanScripts.some((s) => s.endsWith('a-probe.mjs')),
      'a-probe.mjs is reached via the descriptor delegate — must not be flagged');
  });
});

test('findOrphans: allowlisted staged item is tracked, not flagged as orphan', () => {
  withPlugin(({ root }) => {
    const r = findOrphans({ coreRoot: root, allowlist: ALLOW });
    assert.ok(r.allowlisted.includes('staged.mjs'), 'staged.mjs is allowlisted');
    assert.ok(!r.orphanScripts.some((s) => s.endsWith('staged.mjs')), 'allowlisted != orphan');
    assert.match(formatReport(r), /staged\.mjs/, 'report still prints allowlisted items so they stay visible');
  });
});

// Guard against the real tree regressing: the shipped plugin must have no
// un-allowlisted orphans. This is the standing definition-of-done check.
test('the real plugin tree has no un-allowlisted orphans', () => {
  const coreRoot = join(import.meta.dirname, '..', '..', 'plugins', 'core');
  const r = findOrphans({ coreRoot });
  assert.equal(r.orphanScripts.length, 0, `orphan scripts: ${r.orphanScripts.join(', ')}`);
  assert.equal(r.orphanProtocols.length, 0, `orphan protocols: ${r.orphanProtocols.join(', ')}`);
});

test('ALLOWLIST entries carry a non-trivial reason', () => {
  for (const [name, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(reason && reason.length > 30, `${name} needs a real documented reason`);
  }
});
