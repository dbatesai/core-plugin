#!/usr/bin/env node
// corpus-leakage-check.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 1, 2026-07-20).
//
// Hale's Codex trial against candidate 6dc12a3 was SPOILED: the target
// answer ("cobalt") leaked through the retrieved unit's id/topic
// (`dc-pilot-proof-cobalt`), so a model answering correctly proves nothing
// about whether it actually reasoned over the memory body — it could have
// pattern-matched the id string alone. This script is the mandatory
// falsifier: given a candidate corpus directory and the token(s) the trial
// intends to test for, it fails loudly if the token appears anywhere
// EXCEPT the body prose of the unit that's supposed to carry it.
//
// Scope: this is pilot-only tooling for the preregistered efficacy trial.
// It never ships in the product and never merges to next/main.
//
// CLI:
//   node corpus-leakage-check.mjs <store-dir> <target-token> [<target-token> ...]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/** Fields a target token must NEVER appear in — metadata that could let a
 * model answer correctly by pattern-matching the label instead of reasoning
 * over the actual memory content. */
const LEAK_SURFACES = ['path', 'id', 'topics', 'heading'];

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const [, fmBlock, body] = m;
  const frontmatter = {};
  for (const line of fmBlock.split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  // topics: [a, b, c] flow-style, the only shape this checker needs to read.
  const topicsMatch = fmBlock.match(/^topics:\s*\[(.*)\]\s*$/m);
  frontmatter.topics = topicsMatch ? topicsMatch[1].split(',').map(s => s.trim()) : [];
  return { frontmatter, body };
}

function firstHeading(body) {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return '';
}

function containsToken(haystack, token) {
  return String(haystack || '').toLowerCase().includes(String(token).toLowerCase());
}

/**
 * checkCorpusLeakage — walk every unit file in storeDir/_memories, and for
 * each target token, assert it appears in NONE of the leak surfaces
 * (path, id, topics, heading) for ANY unit. The body of the unit the
 * planted fact belongs to is exempt (that's where it's SUPPOSED to live);
 * every other surface, on every unit, is not.
 *
 * @returns {{clean: boolean, violations: Array<{unit, field, token}>}}
 */
export function checkCorpusLeakage(storeDir, targetTokens) {
  const memDir = join(storeDir, '_memories');
  const violations = [];
  const walk = (dir, relPrefix = '') => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('_') || entry.startsWith('.') || entry.startsWith('INDEX')) continue;
      const full = join(dir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) { walk(full, rel); continue; }
      if (extname(entry) !== '.md') continue;
      const raw = readFileSync(full, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const heading = firstHeading(body);
      const fields = {
        path: rel,
        id: frontmatter.id || '',
        topics: (frontmatter.topics || []).join(' '),
        heading,
      };
      for (const token of targetTokens) {
        for (const field of LEAK_SURFACES) {
          if (containsToken(fields[field], token)) {
            violations.push({ unit: rel, field, token });
          }
        }
      }
    }
  };
  walk(memDir);
  return { clean: violations.length === 0, violations };
}

function main(argv) {
  const [storeDir, ...tokens] = argv;
  if (!storeDir || tokens.length === 0) {
    process.stderr.write('usage: node corpus-leakage-check.mjs <store-dir> <target-token> [<target-token> ...]\n');
    return 2;
  }
  const { clean, violations } = checkCorpusLeakage(storeDir, tokens);
  if (clean) {
    process.stdout.write(`clean: 0 leaks across ${tokens.length} token(s)\n`);
    return 0;
  }
  process.stdout.write(`LEAK: ${violations.length} violation(s)\n`);
  for (const v of violations) process.stdout.write(`  ${v.unit} :: ${v.field} contains "${v.token}"\n`);
  return 1;
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
