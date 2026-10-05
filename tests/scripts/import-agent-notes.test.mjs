// The agent's notes are copied once from the old shared folder into the project; after that the
// project copy is the only one read, the old folder is never written, and research waits to be asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAgentNotes } from '../../plugins/core/skills/core/scripts/import-agent-notes.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-agent-notes-')));
  const home = join(base, 'home'), root = join(base, 'proj');
  mkdirSync(join(home, '.core', 'agents', 'retired'), { recursive: true });
  mkdirSync(join(home, '.core', 'research'), { recursive: true });
  mkdirSync(root);
  writeFileSync(join(home, '.core', 'dm-profile.md'), '# legacy profile\n');
  writeFileSync(join(home, '.core', 'topics.md'), 'topics v1\n');
  writeFileSync(join(home, '.core', 'agents', 'anvil.md'), 'anvil\n');
  writeFileSync(join(home, '.core', 'agents', 'retired', 'old.md'), 'old\n');
  writeFileSync(join(home, '.core', 'research', 'index.json'), '{"documents":[]}\n');
  return { base, home, root, agent: join(root, '.core', '_agent') };
}
const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort().map(n => { try { return [n, readFileSync(join(dir, n), 'utf8')]; } catch { return [n]; } });

test('copies each family once, records source digests, and leaves the old folder untouched', () => {
  const { base, home, root, agent } = setup();
  try {
    const before = snapshot(join(home, '.core'));
    const r = importAgentNotes({ root, home });
    assert.equal(r.status, 'ok');
    assert.equal(readFileSync(join(agent, 'agent-profile.md'), 'utf8'), '# legacy profile\n');
    assert.equal(readFileSync(join(agent, 'agents', 'retired', 'old.md'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(agent, '.gitignore'), 'utf8'), '*\n');
    const receipt = JSON.parse(readFileSync(join(agent, 'import-receipt.json'), 'utf8'));
    assert.equal(receipt.families.profile.source, join(home, '.core', 'dm-profile.md'));
    assert.equal(receipt.families.topics.files['.'], sha('topics v1\n'));
    assert.equal(receipt.families.agents.files['retired/old.md'], sha('old\n'));
    assert.equal(receipt.families['task-configs'].result, 'absent');
    assert.equal(receipt.families.research, undefined);
    assert.ok(!existsSync(join(root, '_outputs')), 'research is not copied unless asked');
    assert.deepEqual(snapshot(join(home, '.core')), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a deleted local copy never falls back to the old folder, and a local copy wins', () => {
  const { base, home, root, agent } = setup();
  try {
    mkdirSync(join(agent), { recursive: true });
    writeFileSync(join(agent, 'topics.md'), 'mine\n');
    mkdirSync(join(agent, 'agents'));
    writeFileSync(join(agent, 'agents', 'mine.md'), 'mine\n');
    const first = importAgentNotes({ root, home });
    assert.equal(first.results.find(x => x.family === 'agents').result, 'local-present');
    assert.deepEqual(readdirSync(join(agent, 'agents')), ['mine.md']);
    assert.equal(readFileSync(join(agent, 'topics.md'), 'utf8'), 'mine\n');
    rmSync(join(agent, 'agent-profile.md'));
    writeFileSync(join(home, '.core', 'agent-profile.md'), 'newer global\n');
    const r = importAgentNotes({ root, home });
    assert.ok(r.results.every(x => x.result === 'already-decided'));
    assert.ok(!existsSync(join(agent, 'agent-profile.md')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('links are listed, not followed; research copies only when asked', { skip: process.platform === 'win32' }, () => {
  const { base, home, root, agent } = setup();
  try {
    writeFileSync(join(base, 'secret'), 'outside\n');
    symlinkSync(join(base, 'secret'), join(home, '.core', 'agents', 'link.md'));
    const r = importAgentNotes({ root, home, research: true });
    assert.deepEqual(r.results.find(x => x.family === 'agents').omitted, ['link.md']);
    assert.ok(!existsSync(join(agent, 'agents', 'link.md')));
    assert.equal(readFileSync(join(root, '_outputs', 'research', 'index.json'), 'utf8'), '{"documents":[]}\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
