#!/usr/bin/env node
// generate-skills-manifest.mjs — enumerate every skill CORE ships and its
// public-facing surface, from data that already exists in each SKILL.md's
// frontmatter (`name`, `user-invocable`). Built for downstream overlays
// (e.g. BBLens) that rewrite or filter CORE's command surface and currently
// hand-maintain that list against a moving target (Crest's 2026-07-20
// operator-needs asks 1 and 2) — this replaces the hand-maintained allowlist
// with one generated artifact.
//
// CLI:
//   node generate-skills-manifest.mjs <plugin-root> [--out <file>]
// <plugin-root> is the directory containing skills/ (e.g. plugins/core).
// Without --out, prints JSON to stdout.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './priority.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const SKILLS_MANIFEST_VERSION = '1.0.0';

export function buildSkillsManifest(pluginRoot) {
  const skillsDir = join(resolve(pluginRoot), 'skills');
  const entries = existsSync(skillsDir) ? readdirSync(skillsDir).sort() : [];
  const skills = [];
  for (const name of entries) {
    const skillMdPath = join(skillsDir, name, 'SKILL.md');
    if (!statSync(join(skillsDir, name)).isDirectory() || !existsSync(skillMdPath)) continue;
    const [fm] = parseFrontmatter(readFileSync(skillMdPath, 'utf8'));
    skills.push({
      command: `/${fm.name || name}`,
      dir: name,
      // Default true: every existing skill except `core` itself omits this
      // field and is invocable; `core` is invoked by name without the flag.
      user_invocable: fm['user-invocable'] !== false,
      description: fm.description || '',
    });
  }
  return { manifest_version: SKILLS_MANIFEST_VERSION, skills };
}

function main(argv) {
  const positionals = argv.filter(a => !a.startsWith('--'));
  const pluginRoot = positionals[0];
  if (!pluginRoot) {
    process.stderr.write('usage: generate-skills-manifest.mjs <plugin-root> [--out <file>]\n');
    return 2;
  }
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : null;
  const manifest = buildSkillsManifest(pluginRoot);
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (outFile) atomicWriteFileSync(resolve(outFile), json);
  else process.stdout.write(json);
  return 0;
}

const _cliEntry = (() => { try { return fileURLToPath(import.meta.url) === resolve(process.argv[1]); } catch { return false; } })();
if (_cliEntry) {
  process.exit(main(process.argv.slice(2)));
}
