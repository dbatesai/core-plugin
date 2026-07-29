#!/usr/bin/env node
/**
 * generate-shipped-surface-inventory.mjs — the shipped tree's own answer to "what ships?"
 *
 * A door is anything a user or a harness can enter the plugin through: a skill
 * (typed as a slash command), a hook (fired by a harness event), or a script
 * (invoked by a skill or protocol). This walks the shipped tree and emits one
 * deterministic JSON record per shipped surface: skills and hook doors carry
 * registration; script files carry presence only.
 *
 * Every surface that claims a complete inventory — README, USAGE, llms.txt,
 * INSTALL, the marketplace description — is checked against this output rather
 * than maintained by hand, so a door cannot be added or removed without the
 * claim going stale and the guard going red.
 *
 * Usage:
 *   node generate-shipped-surface-inventory.mjs [--root <plugin-root>] [--out <path>]
 *
 * With no --out the JSON goes to stdout. Exit codes: 0 = emitted, 3 = the
 * plugin root could not be resolved or does not hold a shipped tree.
 *
 * Repo tooling — lives outside the shipped plugin payload; consumed by the
 * inventory guard test and the release flow.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = '1.0.0';

// scripts/ -> core/ -> skills/ -> <plugin root>
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core');

// Which harness fires a hook manifest's doors. A skill or script is shared:
// the same file serves whichever harness loaded the plugin.
const HOOK_MANIFESTS = [
  { file: 'hooks.json', harness: 'claude-code' },
  { file: 'hooks-codex.json', harness: 'codex' },
];

/**
 * Pull `name` and `description` out of a SKILL.md's YAML frontmatter without a
 * YAML dependency. Values may be quoted and may run onto continuation lines;
 * a new key starts at column zero, which is what ends the previous value.
 * @returns {{name: string, description: string}}
 */
export function readSkillFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: '', description: '' };
  const out = { name: '', description: '' };
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(raw);
    if (kv) {
      key = kv[1];
      if (key in out) out[key] = kv[2];
    } else if (key && key in out && raw.trim()) {
      out[key] += ` ${raw.trim()}`;
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim().replace(/^["']|["']$/g, '').trim();
  return out;
}

/**
 * A skill announces its own retirement in the first word of its description —
 * that string is what the harness shows in the skill picker, so a shim that
 * does not lead with it is not telling the user either.
 */
export function skillStatus(description) {
  return /^deprecated\b/i.test(description.trim()) ? 'deprecated' : 'active';
}

function collectSkills(root) {
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return [];
  const surfaces = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const skillMd = join(dir, e.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const fm = readSkillFrontmatter(readFileSync(skillMd, 'utf8'));
    surfaces.push({
      name: fm.name || e.name,
      kind: 'skill',
      harness: 'shared',
      status: skillStatus(fm.description),
      invocation: 'user',
    });
  }
  return surfaces;
}

function collectHooks(root) {
  const surfaces = [];
  for (const { file, harness } of HOOK_MANIFESTS) {
    const path = join(root, 'hooks', file);
    if (!existsSync(path)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    for (const [event, groups] of Object.entries(manifest.hooks || {})) {
      for (const group of groups || []) {
        for (const hook of group.hooks || []) {
          const script = /([\w.-]+\.mjs)/.exec(String(hook.command || ''));
          surfaces.push({
            name: `${event}:${script ? script[1] : String(hook.type || 'command')}`,
            kind: 'hook',
            harness,
            status: 'active',
            invocation: 'automatic',
          });
        }
      }
    }
  }
  return surfaces;
}

function collectScripts(root) {
  const dir = join(root, 'skills', 'core', 'scripts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => ({
      name: basename(e.name, '.mjs'),
      kind: 'script',
      harness: 'shared',
      // Presence in the shipped tree is all this walk can prove. Registration,
      // callers, and invocation class are NOT claimed here — the orphan
      // detector carries static reachability, and door claims require
      // registered-door evidence this generator does not gather.
      surface: 'shipped',
    }));
}

/** Total order over surfaces, so the snapshot is a byte-stable diff target. */
function byDoor(a, b) {
  return a.kind.localeCompare(b.kind)
    || a.harness.localeCompare(b.harness)
    || a.name.localeCompare(b.name);
}

/**
 * @param {string} root plugin root (the directory holding skills/ and hooks/)
 * @returns {{schema_version: string, surfaces: Array<object>}}
 */
export function buildInventory(root = DEFAULT_ROOT) {
  const surfaces = [...collectSkills(root), ...collectHooks(root), ...collectScripts(root)].sort(byDoor);
  return { schema_version: SCHEMA_VERSION, surfaces };
}

/** The commands a user types, minus the agent itself and minus retired shims. */
export function activeCompanions(inventory) {
  return inventory.surfaces.filter(
    (d) => d.kind === 'skill' && d.status === 'active' && d.invocation === 'user' && d.name !== 'core',
  );
}

export function deprecatedSkills(inventory) {
  return inventory.surfaces.filter((d) => d.kind === 'skill' && d.status === 'deprecated');
}

export function serialize(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

function main(argv) {
  let root = DEFAULT_ROOT;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else if (argv[i] === '--out' && argv[i + 1]) out = resolve(argv[++i]);
  }
  if (!existsSync(join(root, 'skills'))) {
    process.stderr.write(`no shipped tree at ${root} (expected a skills/ directory)\n`);
    return 3;
  }
  const text = serialize(buildInventory(root));
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
