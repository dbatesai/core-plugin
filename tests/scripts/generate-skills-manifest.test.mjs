import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSkillsManifest, SKILLS_MANIFEST_VERSION } from '../../plugins/core/skills/core/scripts/generate-skills-manifest.mjs';

function scratchPlugin(skills) {
  const root = mkdtempSync(join(tmpdir(), 'skills-manifest-'));
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const [dir, frontmatter] of Object.entries(skills)) {
    const dirPath = join(skillsDir, dir);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'SKILL.md'), frontmatter);
  }
  return root;
}

test('a skill with no user-invocable field defaults to invocable (matches every existing skill but core)', () => {
  const root = scratchPlugin({
    finalize: '---\nname: finalize\ndescription: closes a session\n---\n\n# /finalize\n',
  });
  try {
    const manifest = buildSkillsManifest(root);
    assert.deepEqual(manifest.skills, [
      { command: '/finalize', dir: 'finalize', user_invocable: true, description: 'closes a session' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('user-invocable: false is honored (excluded from the "invocable" reading, not from the list)', () => {
  const root = scratchPlugin({
    orient: '---\nname: orient\ndescription: deprecated shim\nuser-invocable: false\n---\n\n# /orient\n',
  });
  try {
    const manifest = buildSkillsManifest(root);
    assert.equal(manifest.skills[0].user_invocable, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a directory with no SKILL.md is skipped, not a crash', () => {
  const root = scratchPlugin({});
  mkdirSync(join(root, 'skills', 'scaffolding-only'), { recursive: true });
  try {
    const manifest = buildSkillsManifest(root);
    assert.deepEqual(manifest.skills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a plugin root with no skills/ dir at all returns an empty list, not a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-manifest-empty-'));
  try {
    assert.deepEqual(buildSkillsManifest(root).skills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest_version is stamped so a consumer can detect a shape change', () => {
  const root = scratchPlugin({});
  try {
    assert.equal(buildSkillsManifest(root).manifest_version, SKILLS_MANIFEST_VERSION);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the real shipped skills tree enumerates cleanly, command is exactly the SKILL.md name with a leading slash', () => {
  const realRoot = fileURLToPath(new URL('../../plugins/core', import.meta.url));
  const manifest = buildSkillsManifest(realRoot);
  assert.ok(manifest.skills.length >= 9, 'every shipped skill directory is present');
  const core = manifest.skills.find(s => s.dir === 'core');
  assert.equal(core.command, '/core');
  assert.equal(core.user_invocable, true);
});
