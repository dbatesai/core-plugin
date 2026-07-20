#!/usr/bin/env node
// corpus-leakage-check.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 1, 2026-07-20).
//
// Hale's Codex trial against candidate 6dc12a3 was SPOILED: the target
// answer ("cobalt") leaked through the retrieved unit's id/topic
// (`dc-pilot-proof-cobalt`), so a model answering correctly proves nothing
// about whether it actually reasoned over the memory body — it could have
// pattern-matched the id string alone.
//
// Second re-audit (Hale, hale--34e-b3-independent-reaudit-hold): the first
// version exempted EVERY unit's body from checking, when only the one
// designated carrier unit should ever contain the token — a sibling/decoy
// unit's body leaking the token is just as spoiling as metadata leaking it,
// and its ad hoc frontmatter parser only recognized flow-style
// `topics: [a, b]`, missing block-style `topics:\n  - a\n  - b` entirely.
// Both are fixed here: an explicit carrier is now required per token, every
// OTHER unit's body is checked too, and the real project parseFrontmatter
// (validate.mjs) replaces the ad hoc regex.
//
// Scope: this is pilot-only tooling for the preregistered efficacy trial.
// It never ships in the product and never merges to next/main.
//
// CLI:
//   node corpus-leakage-check.mjs <store-dir> <token>=<carrier-unit-path> [...]

import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../plugins/core/skills/core/scripts/validate.mjs';

/** Metadata fields a target token must NEVER appear in, on ANY unit
 * (including the carrier) — surfaces a model could see without the body
 * ever being delivered. */
const METADATA_SURFACES = ['path', 'id', 'topics', 'heading'];

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

function splitFrontmatterBody(raw) {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return m ? m[1] : raw;
}

function walkStore(memDir) {
  const files = [];
  const walk = (dir, relPrefix = '') => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('_') || entry.startsWith('.') || entry.startsWith('INDEX')) continue;
      const full = join(dir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) { walk(full, rel); continue; }
      if (extname(entry) !== '.md') continue;
      files.push({ rel, full });
    }
  };
  walk(memDir);
  return files;
}

/**
 * checkCorpusLeakage — walk every unit file in storeDir/_memories. For each
 * planted token, its designated carrier unit's BODY is the one place it may
 * legitimately appear; every metadata surface (path/id/topics/heading) on
 * EVERY unit including the carrier, and the BODY of every non-carrier unit,
 * must not contain it.
 *
 * @param {string} storeDir
 * @param {Array<{token: string, carrierUnit: string}>} plants
 *   carrierUnit matches either the unit's relative path (e.g.
 *   "dc-1-proof.md") or its frontmatter `id`.
 * @returns {{clean: boolean, violations: Array<{unit, field, token}>}}
 */
export function checkCorpusLeakage(storeDir, plants) {
  if (!Array.isArray(plants) || plants.length === 0) {
    throw Object.assign(new Error('checkCorpusLeakage requires at least one {token, carrierUnit} plant — an unscoped token list cannot tell a legitimate carrier from a leak'), { code: 'PLANTS_REQUIRED' });
  }
  const memDir = join(storeDir, '_memories');
  const violations = [];
  const files = walkStore(memDir);

  const parsed = files.map(({ rel, full }) => {
    const raw = readFileSync(full, 'utf8');
    const frontmatter = parseFrontmatter(raw);
    const body = splitFrontmatterBody(raw);
    const heading = firstHeading(body);
    const topics = Array.isArray(frontmatter.topics) ? frontmatter.topics : [];
    return {
      rel,
      id: frontmatter.id || '',
      fields: { path: rel, id: frontmatter.id || '', topics: topics.join(' '), heading },
      body,
    };
  });

  const isCarrier = (unit, carrierUnit) => unit.rel === carrierUnit || unit.id === carrierUnit;

  for (const { token, carrierUnit } of plants) {
    const matches = parsed.filter(u => isCarrier(u, carrierUnit));
    if (matches.length === 0) {
      throw Object.assign(new Error(`carrierUnit ${JSON.stringify(carrierUnit)} for token ${JSON.stringify(token)} matches no unit in the corpus`), { code: 'CARRIER_NOT_FOUND' });
    }
    // Hale re-audit (hale--4fa-f624-narrow-pass-new-falsifiers): two units
    // sharing a duplicate frontmatter id, both with the token in their
    // body, both matched the plant -- both counted as "the carrier" and
    // the corpus reported clean. A carrier reference must resolve to
    // exactly one unit; ambiguity here means the corpus itself has a
    // duplicate-id problem the leakage check cannot safely reason past.
    if (matches.length > 1) {
      throw Object.assign(
        new Error(`carrierUnit ${JSON.stringify(carrierUnit)} for token ${JSON.stringify(token)} matches ${matches.length} units (${matches.map(m => m.rel).join(', ')}) — ambiguous, refusing to guess which is the real carrier`),
        { code: 'AMBIGUOUS_CARRIER', candidates: matches.map(m => m.rel) },
      );
    }
    // Hale re-audit (hale--1346f5e-partial-pass-two-fail-open-edges),
    // false pass 1: a designated carrier exists but its body does NOT
    // actually contain the planted token -- checkCorpusLeakage still
    // reported clean:true. A corpus with no planted answer anywhere
    // cannot be a valid efficacy trial corpus at all; that must fail
    // loudly and distinctly from an ordinary leak, not pass by omission.
    if (!containsToken(matches[0].body, token)) {
      throw Object.assign(
        new Error(`carrierUnit ${JSON.stringify(carrierUnit)} (${matches[0].rel}) does not actually contain token ${JSON.stringify(token)} in its body -- the corpus has no planted answer for this trial`),
        { code: 'CARRIER_MISSING_TOKEN', carrier: matches[0].rel },
      );
    }
    for (const unit of parsed) {
      // Metadata surfaces are never allowed to leak the token, carrier included.
      for (const field of METADATA_SURFACES) {
        if (containsToken(unit.fields[field], token)) violations.push({ unit: unit.rel, field, token });
      }
      // Body: only the designated carrier may contain the token.
      if (!isCarrier(unit, carrierUnit) && containsToken(unit.body, token)) {
        violations.push({ unit: unit.rel, field: 'body', token });
      }
    }
  }
  return { clean: violations.length === 0, violations };
}

/**
 * checkStringsForLeakage — Hale's amendment: "include runner prompt/arm/
 * generated-index metadata among the preflight surfaces." A trial's query
 * prompt, its arm label, and any generated index/summary text are surfaces
 * the model sees independent of the corpus itself; a target token in any of
 * them is exactly as spoiling as a leak in the corpus.
 *
 * @param {Record<string,string>} strings  named surface -> text (e.g.
 *   { prompt: '...', arm_label: '...', generated_index: '...' })
 * @param {string[]} tokens
 */
export function checkStringsForLeakage(strings, tokens) {
  const violations = [];
  for (const [surface, text] of Object.entries(strings || {})) {
    for (const token of tokens) {
      if (containsToken(text, token)) violations.push({ unit: `<${surface}>`, field: surface, token });
    }
  }
  return { clean: violations.length === 0, violations };
}

function usage() {
  process.stderr.write('usage: node corpus-leakage-check.mjs <store-dir> <token>=<carrier-unit-path> [...]\n');
  return 2;
}

function main(argv) {
  const [storeDir, ...pairs] = argv;
  if (!storeDir || pairs.length === 0) return usage();
  const plants = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) { process.stderr.write(`invalid argument ${JSON.stringify(pair)}, expected token=carrier-unit-path\n`); return 2; }
    plants.push({ token: pair.slice(0, eq), carrierUnit: pair.slice(eq + 1) });
  }
  let result;
  try {
    result = checkCorpusLeakage(storeDir, plants);
  } catch (e) {
    process.stderr.write(`FATAL: ${e.message}\n`);
    return 2;
  }
  if (result.clean) {
    process.stdout.write(`clean: 0 leaks across ${plants.length} token(s)\n`);
    return 0;
  }
  process.stdout.write(`LEAK: ${result.violations.length} violation(s)\n`);
  for (const v of result.violations) process.stdout.write(`  ${v.unit} :: ${v.field} contains "${v.token}"\n`);
  return 1;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
