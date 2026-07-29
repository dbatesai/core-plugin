import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapProjectPathToSlug } from '../../plugins/core/skills/core/scripts/project-slug.mjs';
import { projectIdentityMismatch } from '../../plugins/core/skills/core/scripts/generate-memory-index.mjs';
import { mappedMemoryPath } from '../../plugins/core/skills/core/scripts/write-visibility-canary.mjs';

test('mapProjectPathToSlug: converts / and . to - (Claude projects-folder encoding)', () => {
  // The bug: a dotted username (corporate accounts) must encode the dot to a hyphen
  // to match Claude Code's real ~/.claude/projects/<slug>/ folder name.
  assert.equal(
    mapProjectPathToSlug('/Users/David.Bates28/Documents/Projects/CORE'),
    '-Users-David-Bates28-Documents-Projects-CORE',
  );
});

test('mapProjectPathToSlug: plain path (no dots) unchanged in shape', () => {
  assert.equal(mapProjectPathToSlug('/Users/dbates/Documents/Projects/CORE'),
    '-Users-dbates-Documents-Projects-CORE');
});

test('mapProjectPathToSlug: Windows backslashes and the drive colon convert', () => {
  // The drive colon must encode too — a ':' is invalid in a path segment on Windows,
  // so the slug can't be a creatable ~/.claude/projects/<slug>/ directory otherwise.
  // The exact encoding Claude Code uses on a real Windows box still wants an
  // on-box confirmation; this at least produces a valid, internally-consistent path.
  assert.equal(mapProjectPathToSlug('C:\\Users\\David.Bates28\\proj'),
    'C--Users-David-Bates28-proj');
});

test('projectIdentityMismatch: dotted username does NOT false-refuse (regression)', () => {
  // Same project, dotted username. The target MEMORY.md lives in Claude's
  // dot→hyphen encoded folder; the source _memories is the dotted real path.
  const memoriesDir = '/Users/David.Bates28/proj/_memories';
  const memoryMdPath =
    '/home/u/.claude/projects/-Users-David-Bates28-proj/memory/MEMORY.md';
  // Before the fix this returned a mismatch ('.' vs '-'); now it's recognized as
  // the same project and returns null (no false cross-project refusal).
  assert.equal(projectIdentityMismatch(memoriesDir, memoryMdPath), null);
});

test('projectIdentityMismatch: genuinely different project still refuses', () => {
  const memoriesDir = '/Users/David.Bates28/projA/_memories';
  const memoryMdPath =
    '/home/u/.claude/projects/-Users-David-Bates28-projB/memory/MEMORY.md';
  const r = projectIdentityMismatch(memoriesDir, memoryMdPath);
  assert.ok(r && r.actualMapped !== r.expectedMapped, 'cross-project write still guarded');
});

test('mappedMemoryPath: dotted username resolves the right MEMORY.md (regression)', () => {
  assert.equal(
    mappedMemoryPath('/Users/David.Bates28/proj', '/home/u'),
    '/home/u/.claude/projects/-Users-David-Bates28-proj/memory/MEMORY.md',
  );
});
