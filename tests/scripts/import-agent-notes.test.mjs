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
  return { base, home, root, agent: join(root, '_core', '_agent') };
}
const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort().map(n => { try { return [n, readFileSync(join(dir, n), 'utf8')]; } catch { return [n]; } });

test('copies each family once, records source digests, and leaves the old folder untouched', () => {
  const { base, home, root, agent } = setup();
  try {
    const before = snapshot(join(home, '.core'));
    const r = importAgentNotes({ root, home });
    assert.equal(r.status, 'ok');
    assert.equal(readFileSync(join(agent, 'dm-profile.md'), 'utf8'), '# legacy profile\n');
    assert.equal(existsSync(join(agent, 'agent-profile.md')), false);
    assert.equal(readFileSync(join(agent, 'agents', 'retired', 'old.md'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(agent, '.gitignore'), 'utf8'), '*\n');
    const receipt = JSON.parse(readFileSync(join(agent, 'import-receipt.json'), 'utf8'));
    assert.equal(receipt.families['dm-profile'].source, join(home, '.core', 'dm-profile.md'));
    assert.equal(receipt.families.profile.result, 'absent');
    assert.ok(!readdirSync(agent).some((n) => n.startsWith('.importing-')), 'no staging left behind');
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
    rmSync(join(agent, 'dm-profile.md'));
    writeFileSync(join(home, '.core', 'agent-profile.md'), 'newer global\n');
    const r = importAgentNotes({ root, home });
    assert.ok(r.results.every(x => x.result === 'already-decided'));
    assert.ok(!existsSync(join(agent, 'agent-profile.md')) && !existsSync(join(agent, 'dm-profile.md')));
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

test('both profile files are kept under their own names', () => {
  const { base, home, root, agent } = setup();
  try {
    writeFileSync(join(home, '.core', 'agent-profile.md'), 'current\n');
    importAgentNotes({ root, home });
    assert.equal(readFileSync(join(agent, 'agent-profile.md'), 'utf8'), 'current\n');
    assert.equal(readFileSync(join(agent, 'dm-profile.md'), 'utf8'), '# legacy profile\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('an unfinished family is staged, recorded as pending, finished when its copy is intact, and held when something else is there', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { base, home, root, agent } = setup();
  try {
    const real = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); };
    syncBuiltinESMExports();
    let r;
    try { r = importAgentNotes({ root, home }); } finally { fs.linkSync = real; syncBuiltinESMExports(); }
    assert.equal(r.status, 'partial');
    assert.deepEqual(['held', 'publish', 'EIO'], ['result', 'stage', 'code'].map((k) => r.results.find((x) => x.family === 'topics')[k]));
    let receipt = JSON.parse(readFileSync(join(agent, 'import-receipt.json'), 'utf8'));
    assert.equal(receipt.families.topics.result, 'pending');
    assert.equal(receipt.families.topics.files['.'], sha('topics v1\n'));
    assert.equal(existsSync(join(agent, 'topics.md')), false);
    assert.equal(importAgentNotes({ root, home }).status, 'ok', 'the next run copies it');
    assert.equal(readFileSync(join(agent, 'topics.md'), 'utf8'), 'topics v1\n');
    assert.ok(!readdirSync(agent).some((n) => n.startsWith('.importing-')));

    // published but not yet recorded as done: finished when the copy is intact
    receipt = JSON.parse(readFileSync(join(agent, 'import-receipt.json'), 'utf8'));
    receipt.families.topics = { ...receipt.families.topics, result: 'pending', staging: '.importing-topics-deadbeef' };
    mkdirSync(join(agent, '.importing-topics-deadbeef'));
    writeFileSync(join(agent, 'import-receipt.json'), JSON.stringify(receipt));
    assert.equal(importAgentNotes({ root, home }).results.find((x) => x.family === 'topics').result, 'copied');
    assert.equal(existsSync(join(agent, '.importing-topics-deadbeef')), false);

    // something else at the destination: held, the local bytes kept
    receipt.families.topics.result = 'pending';
    writeFileSync(join(agent, 'import-receipt.json'), JSON.stringify(receipt));
    writeFileSync(join(agent, 'topics.md'), 'user edit\n');
    const held = importAgentNotes({ root, home });
    assert.equal(held.status, 'partial');
    assert.equal(held.results.find((x) => x.family === 'topics').result, 'held');
    assert.equal(readFileSync(join(agent, 'topics.md'), 'utf8'), 'user edit\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('an unreadable source is not recorded and leaves nothing half-copied; a receipt of the wrong shape copies nothing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { chmodSync } = await import('node:fs');
  const { base, home, root, agent } = setup();
  try {
    chmodSync(join(home, '.core', 'agents', 'retired', 'old.md'), 0o000);
    const r = importAgentNotes({ root, home });
    chmodSync(join(home, '.core', 'agents', 'retired', 'old.md'), 0o644);
    assert.equal(r.status, 'partial');
    assert.deepEqual(['not-copied', 'read', 'EACCES'], ['result', 'stage', 'code'].map((k) => r.results.find((x) => x.family === 'agents')[k]));
    assert.equal(existsSync(join(agent, 'agents')), false);
    assert.ok(!readdirSync(agent).some((n) => n.startsWith('.importing-')));
    assert.equal(JSON.parse(readFileSync(join(agent, 'import-receipt.json'), 'utf8')).families.agents, undefined);
    assert.equal(importAgentNotes({ root, home }).status, 'ok', 'tried again once readable');
    assert.equal(readFileSync(join(agent, 'agents', 'retired', 'old.md'), 'utf8'), 'old\n');

    const { root: root2, agent: agent2, base: base2 } = setup();
    try {
      mkdirSync(agent2, { recursive: true });
      writeFileSync(join(agent2, '.gitignore'), '*\n');
      writeFileSync(join(agent2, 'import-receipt.json'), '{"families":[]}');
      const bad = importAgentNotes({ root: root2, home });
      assert.equal(bad.status, 'receipt-invalid');
      assert.equal(existsSync(join(agent2, 'topics.md')), false);
    } finally { rmSync(base2, { recursive: true, force: true }); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a linked local note is held and reported as not readable', { skip: process.platform === 'win32' }, () => {
  const { base, home, root, agent } = setup();
  try {
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(base, 'elsewhere.md'), 'outside\n');
    symlinkSync(join(base, 'elsewhere.md'), join(agent, 'topics.md'));
    const r = importAgentNotes({ root, home });
    assert.equal(r.status, 'partial');
    assert.equal(r.results.find((x) => x.family === 'topics').result, 'held');
    assert.equal(r.notes['topics.md'], 'link');
    assert.equal(r.notes['dm-profile.md'], 'ok');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a pending record that names a folder not provably this import\'s own is held and the folder left as found', () => {
  const { base, home, root, agent } = setup();
  try {
    rmSync(join(home, '.core', 'agents'), { recursive: true });
    mkdirSync(join(agent, '.importing-user-notes'), { recursive: true });
    writeFileSync(join(agent, '.importing-user-notes', 'keep.md'), 'user-owned staging data\n');
    mkdirSync(join(agent, '.importing-task-configs-0badc0de', 'payload'), { recursive: true });
    writeFileSync(join(agent, '.importing-task-configs-0badc0de', 'payload', 'x.md'), 'not what was recorded\n');
    writeFileSync(join(agent, '.gitignore'), '*\n');
    writeFileSync(join(agent, 'import-receipt.json'), JSON.stringify({ version: 1, families: {
      agents: { result: 'pending', staging: '.importing-user-notes', files: {} },
      'task-configs': { result: 'pending', staging: '.importing-task-configs-0badc0de', files: { 'x.md': sha('recorded\n') } },
    } }));
    const r = importAgentNotes({ root, home });
    assert.equal(r.status, 'partial');
    for (const fam of ['agents', 'task-configs']) assert.equal(r.results.find((x) => x.family === fam).result, 'held', fam);
    assert.equal(readFileSync(join(agent, '.importing-user-notes', 'keep.md'), 'utf8'), 'user-owned staging data\n');
    assert.equal(readFileSync(join(agent, '.importing-task-configs-0badc0de', 'payload', 'x.md'), 'utf8'), 'not what was recorded\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a pending family publishes the snapshot it recorded, even if the old folder changed since; with the snapshot gone it is held and nothing is re-read', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { base, home, root, agent } = setup();
  try {
    const real = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); };
    syncBuiltinESMExports();
    try { importAgentNotes({ root, home }); } finally { fs.linkSync = real; syncBuiltinESMExports(); }
    writeFileSync(join(home, '.core', 'topics.md'), 'changed since\n');
    importAgentNotes({ root, home });
    assert.equal(readFileSync(join(agent, 'topics.md'), 'utf8'), 'topics v1\n', 'the recorded snapshot, not the new bytes');

    const receipt = JSON.parse(readFileSync(join(agent, 'import-receipt.json'), 'utf8'));
    receipt.families.topics = { result: 'pending', staging: '.importing-topics-0000beef', files: { '.': sha('topics v1\n') } };
    writeFileSync(join(agent, 'import-receipt.json'), JSON.stringify(receipt));
    rmSync(join(agent, 'topics.md'));
    const r = importAgentNotes({ root, home });
    assert.equal(r.results.find((x) => x.family === 'topics').result, 'held');
    assert.equal(existsSync(join(agent, 'topics.md')), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a file named __proto__ is hashed like any other; a saved folder holding a link is not reported readable', { skip: process.platform === 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { base, home, root, agent } = setup();
  try {
    writeFileSync(join(home, '.core', 'agents', '__proto__'), 'odd name\n');
    importAgentNotes({ root, home });
    const text = readFileSync(join(agent, 'import-receipt.json'), 'utf8');
    assert.equal(JSON.parse(text).families.agents.files.__proto__, sha('odd name\n'));
    writeFileSync(join(base, 'outside.md'), 'x\n');
    symlinkSync(join(base, 'outside.md'), join(agent, 'agents', 'linked.md'));
    const out = spawnSync(process.execPath, [join(import.meta.dirname, '../../plugins/core/skills/core/scripts/import-agent-notes.mjs'), '--root', root, '--check'], { encoding: 'utf8', env: { ...process.env, HOME: join(base, 'nowhere') } });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /do not read: agents \(contains-link\)/);
    assert.match(out.stdout, /readable: dm-profile\.md, topics\.md/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
