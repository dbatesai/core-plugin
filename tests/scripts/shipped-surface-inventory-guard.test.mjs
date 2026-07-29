import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInventory, serialize, activeCompanions, deprecatedSkills,
} from '../../scripts/release/generate-shipped-surface-inventory.mjs';

// A green test suite coexisted with public docs that contradicted the shipped
// tree and each other: one surface said nine companions, another ten, the
// marketplace enumerated nine and named a different nine, and thirty scripts
// were missing from a document that claims to list every script. The targeted
// guards all passed, because each checked a rule and none checked completeness.
//
// So the inventory is derived from the tree, committed as a snapshot, and every
// surface that claims a complete count is checked against it. Adding or removing
// a door makes this file red until the snapshot is regenerated:
//
//   node scripts/release/generate-shipped-surface-inventory.mjs \
//     --out docs/shipped-surface-inventory.json

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = join(ROOT, 'plugins', 'core');
const SNAPSHOT = join(ROOT, 'docs', 'shipped-surface-inventory.json');
const REGENERATE = 'node scripts/release/generate-shipped-surface-inventory.mjs --out docs/shipped-surface-inventory.json';

const inventory = buildInventory(PLUGIN);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const SURFACES = [
  'README.md', 'USAGE.md', 'llms.txt', 'INSTALL.md',
  join('.claude-plugin', 'marketplace.json'),
  join('plugins', 'core', '.claude-plugin', 'plugin.json'),
  join('plugins', 'core', '.codex-plugin', 'plugin.json'),
];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const NUM = `(?:\\d+|${Object.keys(NUMBER_WORDS).join('|')})`;

function toNumber(token) {
  const word = NUMBER_WORDS[token.toLowerCase()];
  return word === undefined ? Number(token) : word;
}

/** Every `<count> <noun>` claim in `text`, as numbers. */
function claims(text, nounPattern) {
  return [...text.matchAll(new RegExp(`\\b(${NUM})\\s+${nounPattern}`, 'gi'))].map((m) => toNumber(m[1]));
}

test('the committed inventory matches the shipped tree', () => {
  assert.ok(existsSync(SNAPSHOT), `docs/shipped-surface-inventory.json is missing — run: ${REGENERATE}`);
  assert.equal(
    readFileSync(SNAPSHOT, 'utf8'),
    serialize(inventory),
    `the shipped tree's doors no longer match the committed inventory — run: ${REGENERATE}`,
  );
});

test('every companion count claim matches the active companion count', () => {
  const expected = activeCompanions(inventory).length;
  for (const surface of SURFACES) {
    for (const claimed of claims(read(surface), 'companions?\\b')) {
      assert.equal(claimed, expected, `${surface} claims ${claimed} companions; the tree ships ${expected}`);
    }
  }
});

test('every deprecation-shim count claim matches the deprecated skill count', () => {
  const expected = deprecatedSkills(inventory).length;
  for (const surface of SURFACES) {
    for (const claimed of claims(read(surface), 'deprecation shims?\\b')) {
      assert.equal(claimed, expected, `${surface} claims ${claimed} deprecation shims; the tree ships ${expected}`);
    }
  }
});

test('every slash-command count claim matches the shipped skill count', () => {
  const expected = inventory.surfaces.filter((d) => d.kind === 'skill').length;
  for (const surface of SURFACES) {
    for (const claimed of claims(read(surface), 'slash commands ship\\b')) {
      assert.equal(claimed, expected, `${surface} claims ${claimed} slash commands; the tree ships ${expected}`);
    }
  }
});

test('INSTALL.md hook counts match the registered hooks per harness', () => {
  const install = read('INSTALL.md');
  const claude = inventory.surfaces.filter((d) => d.kind === 'hook' && d.harness === 'claude-code').length;
  const codex = inventory.surfaces.filter((d) => d.kind === 'hook' && d.harness === 'codex').length;

  const registers = new RegExp(`registers (${NUM}) hooks`, 'i').exec(install);
  assert.ok(registers, 'INSTALL.md no longer states how many hooks installing CORE registers');
  assert.equal(toNumber(registers[1]), claude, 'INSTALL.md miscounts the Claude Code hooks');

  const split = new RegExp(`(${NUM}) of the (${NUM}) hooks`, 'i').exec(install);
  assert.ok(split, 'INSTALL.md no longer states how many of the hooks Codex gets');
  assert.equal(toNumber(split[1]), codex, 'INSTALL.md miscounts the Codex hooks');
  assert.equal(toNumber(split[2]), claude, 'INSTALL.md miscounts the Claude Code hooks');
});

test('every active user-invocable skill is named in INSTALL.md and USAGE.md', () => {
  const install = read('INSTALL.md');
  const usage = read('USAGE.md');
  for (const door of inventory.surfaces.filter((d) => d.kind === 'skill' && d.invocation === 'user')) {
    assert.ok(install.includes(`/${door.name}`), `INSTALL.md never names the shipped door /${door.name}`);
    assert.ok(usage.includes(`/${door.name}`), `USAGE.md never names the shipped door /${door.name}`);
  }
});

test('every script USAGE.md names exists in the shipped tree', () => {
  const shipped = new Set(inventory.surfaces.filter((d) => d.kind === 'script').map((d) => d.name));
  const named = new Set([...read('USAGE.md').matchAll(/`([\w-]+)\.mjs`/g)].map((m) => m[1]));
  const missing = [...named].filter((n) => !shipped.has(n));
  assert.deepEqual(missing, [], `USAGE.md names scripts that do not ship: ${missing.join(', ')}`);
});

// ---------- shipped prose cites only shipped paths ----------
//
// A shipped document that points at a dev-only test, a deleted script, or a
// planned-but-never-written schema sends a reader somewhere that does not exist,
// and nothing else in the suite notices.

const SHIPPED_SUBTREES = new Set([
  'skills', 'hooks',
  ...readdirSync(join(PLUGIN, 'skills', 'core'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name),
]);
// Repo tooling, never packaged. A shipped doc citing it is always wrong, whether
// or not the file exists in this repo. `docs/` is deliberately not listed: in
// shipped prose that prefix usually names a path inside the *user's* project.
const NEVER_SHIPPED_SUBTREES = new Set(['tests', '.github']);
const CITED_PATH = /`([A-Za-z0-9_][A-Za-z0-9._/-]*\.(?:mjs|md|json|sh))`/g;

function shippedMarkdown(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) shippedMarkdown(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

test('shipped prose cites only paths that exist inside the shipped tree', () => {
  const offenders = [];
  for (const file of shippedMarkdown(join(PLUGIN, 'skills'))) {
    const text = readFileSync(file, 'utf8');
    for (const [, cited] of text.matchAll(CITED_PATH)) {
      if (!cited.includes('/')) continue;
      const head = cited.split('/')[0];
      if (NEVER_SHIPPED_SUBTREES.has(head)) {
        offenders.push(`${file}: ${cited} (outside the shipped plugin)`);
        continue;
      }
      if (!SHIPPED_SUBTREES.has(head)) continue; // a project-data or user path, not ours to resolve
      const bases = [PLUGIN, join(PLUGIN, 'skills', 'core'), dirname(file)];
      if (!bases.some((base) => existsSync(join(base, cited)))) {
        offenders.push(`${file}: ${cited} (resolves nowhere in the shipped tree)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `shipped prose cites paths that do not ship:\n  ${offenders.join('\n  ')}`);
});

test('every relative link in the root documentation surfaces resolves', () => {
  for (const doc of ['README.md', 'USAGE.md', 'INSTALL.md', 'ARCHITECTURE.md']) {
    const src = readFileSync(join(ROOT, doc), 'utf8');
    for (const m of src.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target) continue;
      assert.ok(existsSync(join(ROOT, target)), `${doc} links ${m[1]}, which does not exist`);
    }
  }
});

// --- public manifest rosters are governed surfaces: membership, not count alone ---
// A manifest description can state an accurate COUNT while naming the wrong
// roster (advertising a removed command, omitting a live one). Both source
// manifests' public description text is therefore checked for membership.
const MANIFESTS = [
  join('plugins', 'core', '.claude-plugin', 'plugin.json'),
  join('plugins', 'core', '.codex-plugin', 'plugin.json'),
];

function manifestDescriptionText(rel) {
  const j = JSON.parse(read(rel));
  return [j.description, j.interface?.shortDescription, j.interface?.longDescription]
    .filter(Boolean).join('\n');
}

// Pure over a description text so the planted falsifier below can exercise the
// same checks the live test runs.
export function rosterProblems(text, inv) {
  const problems = [];
  for (const c of activeCompanions(inv)) {
    const name = c.name ?? c;
    if (!new RegExp(`(?<![A-Za-z0-9])/${name}(?![a-z0-9-])`).test(text)) {
      problems.push(`omits active companion /${name}`);
    }
  }
  for (const s of deprecatedSkills(inv)) {
    // A deprecated command may be mentioned, but only labeled as such nearby.
    const re = new RegExp(`(?<![A-Za-z0-9])/${s.name ?? s}(?![a-z0-9-])`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const near = text.slice(Math.max(0, m.index - 120), m.index + 120);
      if (!/shim|deprecat/i.test(near)) problems.push(`describes deprecated /${s.name ?? s} as active`);
    }
  }
  const known = new Set([
    ...activeCompanions(inv).map((c) => c.name ?? c), 'core',
    ...deprecatedSkills(inv).map((s) => s.name ?? s),
  ]);
  for (const m of text.matchAll(/(?<![A-Za-z0-9])\/([a-z][a-z0-9-]{2,})(?![a-z0-9-])/g)) {
    if (!known.has(m[1])) problems.push(`advertises /${m[1]}, which does not ship`);
  }
  return problems;
}

test('both source manifests describe exactly the shipped companion roster', () => {
  for (const rel of MANIFESTS) {
    const problems = rosterProblems(manifestDescriptionText(rel), inventory);
    assert.deepEqual(problems, [], `${rel}:\n  ${problems.join('\n  ')}`);
  }
});

test('FALSIFIER: a planted removed command plus an omitted active command is RED', () => {
  const real = manifestDescriptionText(MANIFESTS[1]);
  // Plant a command that does not ship, and delete a live companion's mention.
  const mutated = real.replace('/refocus', '/metrics-package');
  const problems = rosterProblems(mutated, inventory);
  assert.ok(problems.some((p) => p.includes('omits active companion /refocus')),
    'removing a live companion from the description must be a problem');
  assert.ok(problems.some((p) => p.includes('advertises /metrics-package')),
    'advertising a command that does not ship must be a problem');
});
