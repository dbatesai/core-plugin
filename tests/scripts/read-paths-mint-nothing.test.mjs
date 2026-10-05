// Read paths never create this install's identity: looking at a project's state, with no
// install-secret or install-id on the machine, must leave the core folder exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyStamp, readSignedFile, readSignedFileAt, readInstallIdentity, adoptionCandidate,
  writeStamp, writeSignedFile,
} from '../../plugins/core/skills/core/scripts/project-state.mjs';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mint-')));
  const root = join(base, 'proj'); mkdirSync(root);
  const coreA = join(base, 'coreA'); mkdirSync(coreA);
  const coreB = join(base, 'coreB'); mkdirSync(coreB);   // a machine with no identity yet
  return { base, root, coreA, coreB, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('readInstallIdentity never creates: absent → null, present → the same values the writer made', () => {
  const s = setup();
  try {
    assert.equal(readInstallIdentity({ coreDir: s.coreB }), null);
    assert.deepEqual(readdirSync(s.coreB), []);
    const stamp = writeStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreA });
    assert.equal(readInstallIdentity({ coreDir: s.coreA }).installId, stamp.install_id);
    writeFileSync(join(s.coreB, 'install-secret'), 'not hex\n'); writeFileSync(join(s.coreB, 'install-id'), 'x\n');
    assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, 'a malformed secret is no identity');
  } finally { s.cleanup(); }
});

test('classifying, reading signed files and checking for adoption mint nothing on a machine with no identity', () => {
  const s = setup();
  try {
    // Install A stamps the project and signs a manifest; then the folder is looked at from machine B.
    writeStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreA });
    const dir = join(s.root, '.core', 'claude-code');
    writeSignedFile({ dir, name: 'workspace.json', body: '{"agent_name":"A"}\n', coreDir: s.coreA });
    assert.equal(classifyStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreA }).status, 'verified', 'control: its own install verifies it');

    assert.equal(classifyStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreB }).status, 'foreign-install');
    assert.equal(readSignedFile({ root: s.root, harness: 'claude-code', name: 'workspace.json', coreDir: s.coreB }), null);
    assert.equal(readSignedFileAt({ dir, name: 'workspace.json', coreDir: s.coreA }), '{"agent_name":"A"}\n', 'control: its own install reads it');
    assert.equal(readSignedFileAt({ dir, name: 'workspace.json', coreDir: s.coreB }), null);
    adoptionCandidate({ root: s.root, harness: 'claude-code', coreDir: s.coreB });
    assert.equal(existsSync(join(s.coreB, 'install-secret')), false, 'no secret was created by reading');
    assert.equal(existsSync(join(s.coreB, 'install-id')), false, 'no id was created by reading');

    // Control: a write on machine B is what creates its identity.
    const other = join(s.base, 'proj2'); mkdirSync(other);
    writeStamp({ root: other, harness: 'claude-code', coreDir: s.coreB });
    assert.ok(existsSync(join(s.coreB, 'install-secret')) && existsSync(join(s.coreB, 'install-id')));
  } finally { s.cleanup(); }
});
