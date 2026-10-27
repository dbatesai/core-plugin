import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerProject, touchProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { applyMigration, checkLegacyDrift } from '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs', import.meta.url));
const H = 'claude-code';
const RECEIPT = 'migrated-from.json';

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'receipt-root-'))));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  mkdirSync(coreDir, { recursive: true });
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, home, coreDir, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function legacyWorkspace(s, id, { path, files = {} }) {
  const dir = join(s.coreDir, 'workspaces', id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { workspace_id: id, name: id, path };
}

/** Startup's two migration commands, as the CLI runs them. */
function cli(s, mode, root) {
  const r = spawnSync(process.execPath, [SCRIPT, mode, '--root', root, '--harness', H, '--core-dir', s.coreDir], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported below */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else out.push(f); } };
  if (!existsSync(dir)) return out;
  if (statSync(dir).isDirectory()) walk(dir); else out.push(dir);
  return out;
}

test('a migrated project that is then moved still passes startup\'s apply and drift check at its new path', { todo: 'card 235: receipt root binding' }, () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'Old');
    const legacyLog = join(s.coreDir, 'workspaces', 'legacy', 'capability-history.jsonl');
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([
      legacyWorkspace(s, 'legacy', { path: p, files: {
        'workspace.json': JSON.stringify({ workspace_id: 'legacy', agent_name: 'Plover' }),
        'capability-history.jsonl': '{"row":1}\n',
        'hot-section-draft.md': 'draft\n',
      } }),
    ], null, 2));
    writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify({ version: 1, entries: { legacy: { harness: H, evidence: 'fixture' } } }));
    registerProject(s.coreDir, p);

    const applied = cli(s, '--apply', p);
    assert.equal(applied.json?.status, 'migrated', applied.stdout + applied.stderr);
    const before = cli(s, '--drift-check', p);
    assert.equal(before.status, 0, 'control: the receipt verifies at the path it was written for\n' + before.stdout);
    assert.equal(before.json.status, 'unchanged');

    const moved = join(s.base, 'Projects', 'New');
    renameSync(p, moved);
    registerProject(s.coreDir, moved);
    const touched = touchProject(s.coreDir, { root: moved, harness: H });
    assert.ok(touched.events.some((e) => e.kind === 'state-moved'), 'CORE\'s own move handling ran');

    const apply = cli(s, '--apply', moved);
    process.stdout.write(`# (a) --apply after move: exit ${apply.status} ${JSON.stringify(apply.json)}\n`);
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);

    writeFileSync(legacyLog, '{"row":1}\n{"row":"older-build-2"}\n');
    const drift = cli(s, '--drift-check', moved);
    process.stdout.write(`# (a) --drift-check after move: exit ${drift.status} ${JSON.stringify(drift.json)}\n`);
    assert.equal(drift.status, 0, `drift check after a move exits 0\n${drift.stdout}${drift.stderr}`);
    assert.ok(['unchanged', 'brought-in'].includes(drift.json.status), drift.stdout);
  } finally { s.cleanup(); }
});

test('a signed receipt with an empty file list, copied into another project, is refused and imports nothing', { todo: 'card 235: receipt root binding' }, () => {
  const s = sandbox();
  try {
    const a = s.mk('Projects', 'A');
    const b = s.mk('Projects', 'B');
    // A's legacy workspace holds only names the copy skips, so its real migration signs a receipt listing no files.
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([
      legacyWorkspace(s, 'legacy-a', { path: a, files: { 'visibility-canary.json': '{}', 'capability-history.lock.g1.done': '{}' } }),
    ], null, 2));
    writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify({ version: 1, entries: { 'legacy-a': { harness: H, evidence: 'fixture' } } }));
    registerProject(s.coreDir, a);
    assert.equal(applyMigration({ root: a, harness: H, coreDir: s.coreDir, table: { version: 1, entries: { 'legacy-a': { harness: H, evidence: 'fixture' } } } }).status, 'migrated');
    const aState = join(a, '_core', H);
    const receipt = JSON.parse(readFileSync(join(aState, RECEIPT), 'utf8'));
    assert.equal(receipt.live, 'legacy-a');
    assert.deepEqual(receipt.files, [], 'fixture: A\'s own signed receipt lists no files');

    // Content an older build later writes to A's legacy workspace.
    const aLegacy = join(s.coreDir, 'workspaces', 'legacy-a');
    writeFileSync(join(aLegacy, 'capability-history.jsonl'), '{"row":"SENTINEL-A"}\n');
    writeFileSync(join(aLegacy, 'notes.md'), 'SENTINEL-A private notes\n');

    registerProject(s.coreDir, b);
    touchProject(s.coreDir, { root: b, harness: H });
    const bState = join(b, '_core', H);
    assert.equal(existsSync(join(bState, RECEIPT)), false, 'B was never migrated');
    copyFileSync(join(aState, RECEIPT), join(bState, RECEIPT));
    copyFileSync(join(aState, `${RECEIPT}.mac`), join(bState, `${RECEIPT}.mac`));

    const drift = checkLegacyDrift({ root: b, harness: H, coreDir: s.coreDir });
    process.stdout.write(`# (b) --drift-check on B with A's copied receipt: ${JSON.stringify(drift)}\n`);
    const elsewhere = readdirSync(s.coreDir).filter((n) => n !== 'workspaces').flatMap((n) => filesUnder(join(s.coreDir, n)));
    const leaked = filesUnder(b).concat(elsewhere).filter((f) => readFileSync(f, 'utf8').includes('SENTINEL-A'));
    assert.deepEqual(leaked, [], 'nothing from A\'s legacy workspace reaches B');
    assert.ok(['receipt-unverified', 'not-migrated'].includes(drift.status), `a receipt from another project is refused, got ${drift.status}`);
  } finally { s.cleanup(); }
});
