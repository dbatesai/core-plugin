import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  resolveCoreRoot, detectHarness, checkManifests, validateStore, detectIdentity,
  readConfiguredMcp, readConnectorMap, planAgentsMd, configureProject, formatReceipt, main,
} from '../../plugins/core/skills/core/scripts/configure-project.mjs';

const NOW = new Date('2026-06-01T00:00:00Z');

const UNIT = (id) => `---
id: ${id}
type: decision
status: active
created: 2026-06-01
updated: 2026-06-01
topics: [test]
---
# ${id}
A minimal valid decision unit.
`;

const CONTRACT = `---
schema_version: 1.0
contract_id: demo-project
canonical_for: ["claude-code", "codex"]
maintained_by: David
last_revised: 2026-04-01
---

# Project Contract

## Identity & Voice
Plain person voice. Always.

## Harness-Specific Sections
### claude-code-only
Use the Agent tool.

### codex-only
Use AGENTS.md conventions.
`;

// Build: a project dir, a fake HOME (~/.core + ~/.claude.json), a fake CORE_ROOT
// with both manifests + the skill dir + the codex adapter.
async function withFixture(opts, fn) {
  const {
    units = ['dc-1-test', 'dc-2-test'],
    pointer = null, index = null, claudeJson = null,
    contract = false, connectorMap = null, manifests = true,
  } = opts || {};
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'configure-')));
  const projectPath = join(base, 'project');
  const home = join(base, 'home');
  const coreRoot = join(base, 'core-root');
  mkdirSync(join(projectPath, '_memories'), { recursive: true });
  mkdirSync(join(home, '.core'), { recursive: true });
  mkdirSync(join(coreRoot, 'skills', 'core', 'harnesses'), { recursive: true });

  for (const u of units) writeFileSync(join(projectPath, '_memories', `${u}.md`), UNIT(u));
  if (manifests) {
    mkdirSync(join(coreRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(join(coreRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(join(coreRoot, '.claude-plugin', 'plugin.json'), '{"name":"core","version":"9.9.9"}');
    writeFileSync(join(coreRoot, '.codex-plugin', 'plugin.json'), '{"name":"core","version":"9.9.9"}');
  }
  writeFileSync(join(coreRoot, 'skills', 'core', 'harnesses', 'codex.md'), '# codex adapter');
  writeFileSync(join(coreRoot, 'skills', 'core', 'harnesses', 'claude-code.md'), '# claude adapter');

  if (pointer) writeFileSync(join(projectPath, 'workspace.json'), JSON.stringify(pointer, null, 2));
  if (index) writeFileSync(join(home, '.core', 'index.json'), JSON.stringify(index, null, 2));
  if (claudeJson) writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson, null, 2));
  if (contract) writeFileSync(join(projectPath, 'CONTRACT.md'), CONTRACT);
  if (connectorMap) writeFileSync(join(projectPath, 'connector-map.json'), JSON.stringify(connectorMap, null, 2));

  try { return await fn({ projectPath, home, coreRoot, base }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

// ---------- resolveCoreRoot / detectHarness ----------

test('resolveCoreRoot honors an explicit override', () => {
  // Compare against the platform's own resolve() — on Windows the override resolves to a
  // drive-letter backslash path, so a hardcoded POSIX string would falsely fail.
  assert.equal(resolveCoreRoot({ coreRootArg: '/x/y/z' }), resolve('/x/y/z'));
});

test('resolveCoreRoot walks three up from the scripts dir', () => {
  // file:///…/plugins/core/skills/core/scripts/foo.mjs  →  …/plugins/core
  const url = 'file:///tmp/p/plugins/core/skills/core/scripts/configure-project.mjs';
  // Expected computed with the same platform path ops (Windows produces a drive+backslash path).
  assert.equal(resolveCoreRoot({ scriptUrl: url }), resolve(dirname(fileURLToPath(url)), '..', '..', '..'));
});

test('detectHarness: codex env signals codex, else claude-code', () => {
  assert.equal(detectHarness({ CODEX_PLUGIN_ROOT: '/x' }), 'codex');
  assert.equal(detectHarness({ CORE_HARNESS: 'codex' }), 'codex');
  assert.equal(detectHarness({}), 'claude-code');
});

// ---------- manifests ----------

test('checkManifests reports presence of both manifests + skill dir + adapters', async () => {
  await withFixture({}, ({ coreRoot }) => {
    const m = checkManifests(coreRoot);
    assert.equal(m.claudePlugin, true);
    assert.equal(m.codexPlugin, true);
    assert.equal(m.skillCoreDir, true);
    assert.equal(m.codexAdapter, true);
    assert.equal(m.claudeAdapter, true);
  });
});

test('checkManifests reports a missing manifest honestly', async () => {
  await withFixture({ manifests: false }, ({ coreRoot }) => {
    const m = checkManifests(coreRoot);
    assert.equal(m.claudePlugin, false);
    assert.equal(m.codexPlugin, false);
    assert.equal(m.skillCoreDir, true); // skill dir still there
  });
});

// ---------- store validation (no-units guard + tiers) ----------

test('validateStore: a clean store passes with the unit count', async () => {
  await withFixture({ units: ['dc-1-test', 'dc-2-test', 'dc-3-test'] }, ({ projectPath }) => {
    const s = validateStore(projectPath, NOW);
    assert.equal(s.found, true);
    assert.equal(s.noUnits, false);
    assert.equal(s.unitCount, 3);
    assert.ok(s.exitTier === 0 || s.exitTier === 1, 'clean store is non-blocking (0 or 1)');
  });
});

test('validateStore: empty _memories does NOT slip through as pass (no-units guard)', async () => {
  await withFixture({ units: [] }, ({ projectPath }) => {
    const s = validateStore(projectPath, NOW);
    assert.equal(s.noUnits, true, 'must report no-units, not exit 0');
    assert.equal(s.exitTier, 3);
  });
});

test('validateStore: a schema-invalid unit hard-fails (tier 2)', async () => {
  await withFixture({ units: [] }, ({ projectPath }) => {
    writeFileSync(join(projectPath, '_memories', 'bad.md'),
      '---\nid: bad\ntype: not-a-real-type\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n# bad\n');
    const s = validateStore(projectPath, NOW);
    assert.equal(s.exitTier, 2, 'invalid type enum is a hard fail');
  });
});

// ---------- identity (detect-only, never mutates) ----------

test('detectIdentity: a copied pointer reports would-fork and writes nothing', async () => {
  await withFixture({
    pointer: { workspace_id: 'orig', name: 'p' },
    index: [{ workspace_id: 'orig', name: 'p', path: '/elsewhere/entirely' }],
  }, ({ projectPath, home }) => {
    const coreDir = join(home, '.core');
    const before = readFileSync(join(coreDir, 'index.json'), 'utf8');
    const id = detectIdentity(projectPath, coreDir, NOW);
    assert.equal(id.status, 'would-fork');
    assert.equal(id.original_id, 'orig');
    assert.equal(readFileSync(join(coreDir, 'index.json'), 'utf8'), before, 'identity detection must not mutate the index');
  });
});

test('detectIdentity: a registered path is returning', async () => {
  await withFixture({ pointer: { workspace_id: 'ws', name: 'p' } }, ({ projectPath, home }) => {
    const coreDir = join(home, '.core');
    writeFileSync(join(coreDir, 'index.json'),
      JSON.stringify([{ workspace_id: 'ws', name: 'p', path: projectPath }], null, 2));
    const id = detectIdentity(projectPath, coreDir, NOW);
    assert.equal(id.reason, 'path-match');
  });
});

// ---------- JC-1: configured MCP is read honestly, never asserts absence ----------

test('readConfiguredMcp (claude): reads ~/.claude.json and reports declared servers', async () => {
  await withFixture({ claudeJson: { mcpServers: { foo: {}, bar: {} } } }, ({ projectPath, home }) => {
    const r = readConfiguredMcp(projectPath, 'claude-code', home);
    assert.equal(r.checked, true);
    assert.deepEqual(r.servers, ['bar', 'foo']);
    assert.match(r.note, /declared in config, not verified/);
  });
});

test('readConfiguredMcp (claude): no ~/.claude.json -> not-checked, not a false "0 servers"', async () => {
  await withFixture({}, ({ projectPath, home }) => {
    const r = readConfiguredMcp(projectPath, 'claude-code', home);
    assert.equal(r.checked, false);
    assert.equal(r.servers, null, 'must NOT assert an empty server list when it never read the file');
  });
});

test('readConfiguredMcp (codex): does not parse config.toml; defers server list to session-live', async () => {
  await withFixture({}, ({ projectPath, home }) => {
    const r = readConfiguredMcp(projectPath, 'codex', home);
    assert.equal(r.checked, false);
    assert.equal(r.servers, null);
    assert.match(r.note, /session-live/);
  });
});

// ---------- B5: optional overlay-provided connector map ----------

test('readConnectorMap: absent -> CORE ships none', async () => {
  await withFixture({}, ({ projectPath }) => {
    assert.equal(readConnectorMap(projectPath).present, false);
  });
});

test('readConnectorMap: an overlay-provided map is read + counted', async () => {
  await withFixture({ connectorMap: { connectors: { asana: 'mcp__codex_apps__asana', jira: 'mcp__codex_apps__jira' } } },
    ({ projectPath }) => {
      const r = readConnectorMap(projectPath);
      assert.equal(r.present, true);
      assert.equal(r.count, 2);
    });
});

// ---------- B6a: AGENTS.md guarded on CONTRACT.md ----------

test('planAgentsMd: no CONTRACT.md -> skipped, never crashes (the common case)', async () => {
  await withFixture({}, async ({ projectPath }) => {
    const a = await planAgentsMd(projectPath, { apply: true });
    assert.equal(a.status, 'skipped-no-contract');
    assert.equal(existsSync(join(projectPath, 'AGENTS.md')), false);
  });
});

test('planAgentsMd: CONTRACT.md present, dry-run -> would-generate', async () => {
  await withFixture({ contract: true }, async ({ projectPath }) => {
    const a = await planAgentsMd(projectPath, { apply: false });
    assert.equal(a.status, 'would-generate');
    assert.equal(existsSync(join(projectPath, 'AGENTS.md')), false, 'dry-run writes nothing');
  });
});

test('planAgentsMd: CONTRACT.md present + apply -> actually generates AGENTS.md (B6a wiring)', async () => {
  await withFixture({ contract: true }, async ({ projectPath }) => {
    const a = await planAgentsMd(projectPath, { apply: true });
    assert.equal(a.status, 'generated');
    assert.ok(existsSync(join(projectPath, 'AGENTS.md')), 'AGENTS.md must exist after apply');
    assert.match(readFileSync(join(projectPath, 'AGENTS.md'), 'utf8'), /Plain person voice/);
  });
});

// ---------- configureProject: full structured report ----------

test('configureProject: assembles the two-tier report; report-only writes nothing', async () => {
  await withFixture({
    contract: true,
    pointer: { workspace_id: 'ws', name: 'p' },
    claudeJson: { mcpServers: { foo: {} } },
  }, async ({ projectPath, home, coreRoot }) => {
    writeFileSync(join(home, '.core', 'index.json'),
      JSON.stringify([{ workspace_id: 'ws', name: 'p', path: projectPath }], null, 2));
    const r = await configureProject({ projectPath, coreRoot, harness: 'claude-code', home, today: NOW });
    assert.equal(r.schema, 'configure-project/1');
    assert.equal(r.scriptVisible.store.noUnits, false);
    assert.equal(r.scriptVisible.identity.reason, 'path-match');
    assert.equal(r.scriptVisible.mcp.checked, true);
    assert.equal(r.scriptVisible.agentsMd.status, 'would-generate', 'report-only does not generate');
    assert.ok(Array.isArray(r.sessionLive) && r.sessionLive.length >= 1, 'session-live questions present');
    assert.equal(existsSync(join(projectPath, 'AGENTS.md')), false, 'report-only mode writes nothing');

    // formatReceipt renders both tiers in plain voice.
    const receipt = formatReceipt(r);
    assert.match(receipt, /Script-visible/);
    assert.match(receipt, /Session-live/);
    assert.match(receipt, /not verified reachable|declared in config|configured, not verified/);
  });
});

test('configureProject: idempotent from run 2 (detect-only identity, no drift)', async () => {
  await withFixture({ pointer: { workspace_id: 'ws', name: 'p' } }, async ({ projectPath, home, coreRoot }) => {
    writeFileSync(join(home, '.core', 'index.json'),
      JSON.stringify([{ workspace_id: 'ws', name: 'p', path: projectPath }], null, 2));
    const r1 = await configureProject({ projectPath, coreRoot, harness: 'claude-code', home, today: NOW });
    const r2 = await configureProject({ projectPath, coreRoot, harness: 'claude-code', home, today: NOW });
    // Structural equality of the script-visible tier (no timestamps in it).
    assert.deepEqual(r2.scriptVisible, r1.scriptVisible, 'second run is structurally identical — idempotent');
  });
});

// ---------- main(): exit codes ----------

test('main: clean store + report-only -> exit 0, prints a receipt', async () => {
  await withFixture({}, async ({ projectPath, coreRoot }) => {
    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { logs.push(s); return true; };
    let code;
    try { code = await main(['--project', projectPath, '--core-root', coreRoot, '--harness', 'claude-code']); }
    finally { process.stdout.write = orig; }
    assert.equal(code, 0);
    assert.match(logs.join(''), /configure-project/);
  });
});

test('main: a hard-fail store -> exit 2', async () => {
  await withFixture({ units: [] }, async ({ projectPath, coreRoot }) => {
    writeFileSync(join(projectPath, '_memories', 'bad.md'),
      '---\nid: bad\ntype: not-a-real-type\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n# bad\n');
    const orig = process.stdout.write;
    process.stdout.write = () => true;
    let code;
    try { code = await main(['--project', projectPath, '--core-root', coreRoot, '--harness', 'claude-code']); }
    finally { process.stdout.write = orig; }
    assert.equal(code, 2);
  });
});
