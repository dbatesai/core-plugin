// In project-only mode CORE looks at nothing outside the project for optional evidence: the
// harness's memory, transcripts and connector config, and the optional capability probes. Each is
// reported as not observed, never as absent or clean; without the mode the same calls observe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartup } from '../../plugins/core/skills/core/scripts/capability-probe.mjs';
import { resolveTranscript } from '../../plugins/core/skills/core/scripts/read-transcript.mjs';
import { readConfiguredMcp } from '../../plugins/core/skills/core/scripts/configure-project.mjs';
import { resolveAutoMemorySurface } from '../../plugins/core/skills/core/scripts/check-context-integrity.mjs';
import { recordSnapshot } from '../../plugins/core/skills/core/scripts/record-capability-snapshot.mjs';
import { mapProjectPathToSlug } from '../../plugins/core/skills/core/scripts/project-slug.mjs';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';

function fixture({ projectOnly }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-restrictive-')));
  const root = join(base, 'proj'), home = join(base, 'home');
  mkdirSync(root);
  if (projectOnly) mkdirSync(join(root, '_core', '_project-only', 'claude-code'), { recursive: true });
  const tdir = join(home, '.claude', 'projects', mapProjectPathToSlug(root));
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, 'sess-1.jsonl'), '{}\n');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: {} } }));
  return { base, root, home, transcript: join(tdir, 'sess-1.jsonl') };
}

for (const projectOnly of [true, false]) {
  test(`${projectOnly ? 'project-only: nothing outside is looked at' : 'control: the same calls observe'}`, async () => {
    const f = fixture({ projectOnly });
    try {
      const imported = [];
      const startup = await runStartup({ harness: 'claude-code', cwd: f.root, _importer: async (p) => { imported.push(p); return { probe: async () => ({ identity_status: 'PASS' }) }; } });
      const t = resolveTranscript('claude-code', { cwd: f.root, home: f.home, sessionId: 'sess-1', env: {} });
      const named = resolveTranscript('claude-code', { cwd: f.root, home: f.home, override: f.transcript, env: {} });
      const mcp = readConfiguredMcp(f.root, 'claude-code', f.home);
      const mem = resolveAutoMemorySurface({ harness: 'claude-code', cwd: f.root, home: f.home, explicitPath: join(f.home, 'm.md') });
      if (projectOnly) {
        assert.deepEqual(imported, [], 'no optional probe was loaded');
        const optional = startup.rows.filter((r) => /not observed: project-only/.test(JSON.stringify(r)));
        assert.ok(optional.length > 0 && optional.every((r) => r.identity_status === 'UNKNOWN'), JSON.stringify(startup.rows.map((r) => [r.capability_id, r.identity_status])));
        assert.deepEqual([t.path, t.reason, named.path, named.reason], [null, 'project-only', null, 'project-only']);
        assert.deepEqual([mcp.checked, mcp.servers], [false, null]);
        assert.deepEqual([mem.skipped, mem.reason], [true, 'project-only']);
      } else {
        assert.ok(imported.length > 0);
        assert.equal(t.path, f.transcript);
        assert.equal(named.path, f.transcript);
        assert.deepEqual(mcp.servers, ['a']);
        assert.equal(mem.skipped, false);
      }
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
}

test('the snapshot recorder records the startup probe it is handed instead of probing again', async () => {
  const f = fixture({ projectOnly: false });
  try {
    const from = join(f.base, 'capability-state.json');
    const row = { capability_id: 'x', identity_status: 'UNKNOWN' };
    const saved = (o) => writeFileSync(from, JSON.stringify({ harness: 'claude-code', mode: 'startup', complete: true, rows: [row], summary: { marker: 'from-the-startup-probe' }, ...o }));
    const rec = () => recordSnapshot({ cwd: f.root, root: f.root, from, harness: 'claude-code', home: f.home });
    saved({});
    assert.deepEqual((await rec()).summary, { marker: 'from-the-startup-probe' });
    saved({ harness: 'codex' });
    await assert.rejects(rec, /not a startup probe result for claude-code/, 'another harness\'s result is not recorded as this one');
    saved({ mode: 'pre-action' });
    await assert.rejects(rec, /not a startup probe result/);
    for (const rows of [[], 'not a list', [{ capability_id: 'x' }]]) { saved({ rows }); await assert.rejects(rec, /no probe rows/); }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a saved probe goes only into the history of its own harness, with real rows, and lands there', async () => {
  const f = fixture({ projectOnly: false });
  try {
    registerProject(join(f.home, '.core'), f.root);
    const from = join(f.base, 'capability-state.json');
    const saved = (harness, rows) => writeFileSync(from, JSON.stringify({ harness, mode: 'startup', complete: true, rows, summary: {} }));
    const rec = (o = {}) => recordSnapshot({ cwd: f.root, root: f.root, from, home: f.home, env: { CORE_HARNESS: 'claude-code' }, ...o });
    saved('codex', [{ capability_id: 'x', identity_status: 'PASS' }]);
    await assert.rejects(() => rec(), /not a startup probe result for claude-code/, 'no --harness: the detected history decides');
    await assert.rejects(() => rec({ harness: 'codex', stateHarness: 'claude-code' }), /conflicts with the history/);
    for (const row of [{ capability_id: ' ', identity_status: 'PASS' }, { capability_id: 'x', identity_status: 'MAYBE' }]) {
      saved('claude-code', [row]);
      await assert.rejects(() => rec(), /no probe rows/);
    }
    saved('claude-code', [{ capability_id: 'x', identity_status: 'UNKNOWN' }]);
    const r = await rec();
    assert.equal(r.appended, 1, JSON.stringify(r));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
