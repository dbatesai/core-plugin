import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  hashTree, verifyCopiedTree, moveStagingToFolder,
} from '../../plugins/core/skills/core/scripts/metrics-package.mjs';

function makeStaging(root) {
  const staging = join(root, 'staging');
  mkdirSync(join(staging, 'projects', 'project-abc123def456'), { recursive: true });
  writeFileSync(join(staging, 'manifest.json'), '{"schema_version":"1.0.0"}\n');
  writeFileSync(join(staging, 'REPORT.md'), '# report\n');
  writeFileSync(join(staging, 'projects', 'project-abc123def456', 'headline.json'), '{"units_total":3}\n');
  return staging;
}

function fingerprint(dir) {
  return [...hashTree(dir).entries()].map(([rel, sha]) => `${rel}:${sha}`).sort().join('\n');
}

test('a copy that never completed leaves the source retained, byte-identical', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-move-a-'));
  try {
    const staging = makeStaging(root);
    const before = fingerprint(staging);
    // The destination path is already occupied by a plain file: the copy cannot
    // complete, which is the state an interruption leaves behind.
    const folder = join(root, 'core-metrics-package-20260729-000000');
    writeFileSync(folder, 'occupied');

    const res = moveStagingToFolder(staging, folder);
    assert.equal(res.ok, false);
    assert.equal(res.source_retained, staging);
    assert.equal(existsSync(staging), true, 'the source survives an unproven copy');
    assert.equal(fingerprint(staging), before, 'and survives byte-identical');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a complete copy is hash-verified before the source is deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-move-b-'));
  try {
    const staging = makeStaging(root);
    const folder = join(root, 'shipped');
    const res = moveStagingToFolder(staging, folder);
    assert.equal(res.ok, true, res.reason);
    assert.equal(existsSync(staging), false, 'a verified copy retires the source');
    assert.equal(readFileSync(join(folder, 'manifest.json'), 'utf8'), '{"schema_version":"1.0.0"}\n');
    assert.equal(readFileSync(join(folder, 'projects', 'project-abc123def456', 'headline.json'), 'utf8'), '{"units_total":3}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifyCopiedTree names a changed file and a missing file rather than passing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-move-c-'));
  try {
    const staging = makeStaging(root);
    const dest = join(root, 'copy');
    mkdirSync(join(dest, 'projects', 'project-abc123def456'), { recursive: true });
    writeFileSync(join(dest, 'manifest.json'), '{"schema_version":"1.0.0"}\n');
    writeFileSync(join(dest, 'REPORT.md'), '# tampered\n');
    // headline.json never arrived

    const res = verifyCopiedTree(staging, dest);
    assert.equal(res.ok, false);
    assert.deepEqual(res.mismatched, ['REPORT.md']);
    assert.deepEqual(res.missing, ['projects/project-abc123def456/headline.json']);

    assert.equal(verifyCopiedTree(staging, staging).ok, true, 'a tree matches itself');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hashTree records a sha256 per relative path', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-move-d-'));
  try {
    const staging = makeStaging(root);
    const tree = hashTree(staging);
    assert.equal(tree.get('manifest.json'), createHash('sha256').update('{"schema_version":"1.0.0"}\n').digest('hex'));
    assert.ok(tree.has('projects/project-abc123def456/headline.json'), 'nested paths are relative and slash-joined');
    assert.equal(tree.size, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a pre-existing extra file in the destination fails the move; staging is retained', async () => {
  const { moveStagingToFolder } = await import('../../plugins/core/skills/core/scripts/metrics-package.mjs');
  const root = mkdtempSync(join(tmpdir(), 'move-extras-'));
  try {
    const staging = join(root, 'staging');
    const dest = join(root, 'dest');
    mkdirSync(staging, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(staging, 'report.md'), 'the package');
    writeFileSync(join(dest, 'secret.txt'), 'PreexistingPlant5519');

    const r = moveStagingToFolder(staging, dest);
    assert.equal(r.ok, false, 'a destination with extra content is not the staged tree');
    assert.ok(/extra/.test(r.reason), 'the reason names the extra path class: ' + r.reason);
    assert.ok(existsSync(join(staging, 'report.md')), 'staging is retained on refusal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
