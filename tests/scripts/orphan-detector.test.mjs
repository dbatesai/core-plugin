import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findOrphans, formatReport, ALLOWLIST } from '../../plugins/core/skills/core/scripts/orphan-detector.mjs';

// Build a throwaway plugin tree: <root>/skills/core/{SKILL.md,scripts,hooks,protocols}.
function withPlugin(fn) {
  const root = mkdtempSync(join(tmpdir(), 'orphan-'));
  const core = join(root, 'skills', 'core');
  const scripts = join(core, 'scripts');
  const probes = join(scripts, 'capability');
  const hooks = join(core, 'hooks');
  const protocols = join(core, 'protocols');
  const manifestDir = join(root, 'hooks'); // sibling of skills/, the real hooks.json location
  for (const d of [scripts, probes, hooks, protocols, join(core, 'schemas'), manifestDir]) mkdirSync(d, { recursive: true });

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

  // Logged gap, fixed 2026-07-19: a real hook entry point (registered in
  // hooks.json, NOT skill prose) that imports a scripts/ utility ONLY from
  // that hook — nothing in scripts/ ever touches it.
  writeFileSync(join(manifestDir, 'hooks.json'),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/core/hooks/a-hook.mjs"' }] }] } }, null, 2));
  writeFileSync(join(hooks, 'a-hook.mjs'), "import { u } from '../scripts/hook-only-util.mjs';\nexport const run = u;\n");
  writeFileSync(join(scripts, 'hook-only-util.mjs'), 'export const u = 1;\n');
  // A hook file registered nowhere and imported by nothing — a genuine hook-level orphan.
  writeFileSync(join(hooks, 'orphan-hook.mjs'), 'export const deadCode = 1;\n');

  try { return fn({ root, scripts, hooks, protocols }); }
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

// A logged gap: hook files
// were entirely absent from the scan, so a scripts/ utility imported ONLY
// from a hook was structurally invisible to the import closure.
test('findOrphans: a hook registered in hooks.json wires in the scripts/ utility it ONLY imports', () => {
  withPlugin(({ root }) => {
    const r = findOrphans({ coreRoot: root, allowlist: ALLOW });
    assert.ok(!r.orphanScripts.some((s) => s.includes('hooks') && s.endsWith('a-hook.mjs')),
      'a-hook.mjs is registered directly in hooks.json');
    assert.ok(!r.orphanScripts.some((s) => s.endsWith('hook-only-util.mjs')),
      'hook-only-util.mjs is reached ONLY via the hook import chain — the exact defect that was invisible before the fix');
  });
});

test('findOrphans: a hook file registered nowhere and imported by nothing is flagged (genuine hook-level dead code)', () => {
  withPlugin(({ root }) => {
    const r = findOrphans({ coreRoot: root, allowlist: ALLOW });
    assert.ok(r.orphanScripts.some((s) => s.endsWith('orphan-hook.mjs')),
      'a hook file with no manifest registration and no importer must be flagged, not silently ignored');
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

test('ALLOWLIST entries carry a non-trivial reason and a review date', () => {
  for (const [name, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(entry.reason && entry.reason.length > 30, `${name} needs a real documented reason`);
    assert.match(entry.reviewBy || '', /^\d{4}-\d{2}-\d{2}$/, `${name} needs a reviewBy date — allowlists must expire`);
  }
});

test('shipped allowlist contains no obsolete obligation-ladder scorer', () => {
  assert.equal(Object.hasOwn(ALLOWLIST, 'score-ladder.mjs'), false);
});

test('MEM-017: a past reviewBy flags the allowlist entry as stale and the report says so', () => {
  withPlugin(({ root }) => {
    const allow = { 'staged.mjs': { reason: 'deliberately staged pending decision X — full reason here', allowlistDate: '2026-01-01', reviewBy: '2026-02-01' } };
    const r = findOrphans({ coreRoot: root, allowlist: allow, today: new Date('2026-06-09') });
    assert.deepEqual(r.staleAllowlisted, ['staged.mjs']);
    assert.match(formatReport(r), /REVIEW OVERDUE/);
  });
});

test('MEM-017: a future reviewBy is not stale; legacy string entries never go stale', () => {
  withPlugin(({ root }) => {
    const future = { 'staged.mjs': { reason: 'deliberately staged pending decision X — full reason here', allowlistDate: '2026-06-01', reviewBy: '2027-01-01' } };
    assert.deepEqual(findOrphans({ coreRoot: root, allowlist: future, today: new Date('2026-06-09') }).staleAllowlisted, []);
    const legacy = { 'staged.mjs': 'deliberately staged — string-form entry, long enough reason' };
    assert.deepEqual(findOrphans({ coreRoot: root, allowlist: legacy, today: new Date('2026-06-09') }).staleAllowlisted, []);
  });
});
