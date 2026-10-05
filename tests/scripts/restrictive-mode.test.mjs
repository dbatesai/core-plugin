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
    writeFileSync(from, JSON.stringify({ harness: 'claude-code', mode: 'startup', complete: true, rows: [], summary: { marker: 'from-the-startup-probe' } }));
    const r = await recordSnapshot({ cwd: f.root, root: f.root, from, harness: 'claude-code', home: f.home });
    assert.deepEqual(r.summary, { marker: 'from-the-startup-probe' });
    writeFileSync(from, '{"rows": "not a list"}');
    await assert.rejects(() => recordSnapshot({ cwd: f.root, root: f.root, from, harness: 'claude-code', home: f.home }), /no probe rows/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
