/**
 * migrate-to-contract.mjs — v3.0 §5: bootstrap a CONTRACT.md from existing per-harness
 * instruction files (CLAUDE.md / AGENTS.md).
 *
 * For projects already maintaining harness files by hand, this drafts the canonical
 * contract so they can switch to generate-from-contract. Strategy (line-level):
 *   - a line present in 2+ harness files → canonical (shared) content
 *   - a line unique to one harness → that harness's harness-only section
 *   - an existing generated-provenance header is stripped (never migrated)
 *
 * SAFETY (per the v3.0 plan): output is a DRAFT for explicit user review — this never
 * auto-adopts. The agent shows the draft; the user accepts; then generate-* takes over.
 * dry-run by default; --write only writes the draft file when asked.
 *
 * Ships with the plugin as a script; .mjs only.
 *
 * CLI:
 *   node migrate-to-contract.mjs --id <contract-id> [--claude CLAUDE.md] [--codex AGENTS.md]
 *        [--last-revised YYYY-MM-DD] [--write CONTRACT.md]
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HARNESS_OUTPUT, KNOWN_HARNESSES } from './contract-format.mjs';

const HARNESS_ONLY = { 'claude-code': 'claude-code-only', codex: 'codex-only' };

// Drop a leading <!-- GENERATED FROM CONTRACT ... --> block so a previously-generated
// file doesn't carry its provenance header into the new contract.
function stripProvenance(text) {
  return String(text || '').replace(/^<!--\s*\n?GENERATED FROM CONTRACT[\s\S]*?-->\s*\n?/, '').trim();
}

function meaningfulLines(text) {
  return stripProvenance(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
}

// Frontmatter scalars are interpolated into YAML — reject values that could inject extra
// lines/keys (security review repro: `contract_id: "demo\nmalicious: true"`).
function safeScalar(name, value, pattern) {
  const v = String(value ?? '');
  if (!pattern.test(v)) throw new Error(`migrate: invalid ${name} '${v}' — must match ${pattern} (frontmatter-injection guard)`);
  return v;
}

export function migrateToContract({ files = {}, contractId, lastRevised }) {
  // Validate before interpolating into YAML frontmatter.
  contractId = safeScalar('contract_id', contractId, /^[A-Za-z0-9._-]+$/);
  lastRevised = safeScalar('last_revised', lastRevised, /^(\d{4}-\d{2}-\d{2}|unknown)$/);

  const allKeys = Object.keys(files).filter((h) => files[h] != null);
  const harnesses = allKeys.filter((h) => KNOWN_HARNESSES.includes(h));
  const inputWarnings = allKeys.filter((h) => !KNOWN_HARNESSES.includes(h)).map((h) => `ignoring unknown harness key '${h}' (known: ${KNOWN_HARNESSES.join(', ')})`);
  // Review rule: WARN on weak provenance at migrate-time (don't hard-reject a draft) — but make
  // it explicit that the artifact is non-releaseable until a real last_revised is supplied
  // (the generator gate fails closed on 'unknown').
  if (lastRevised === 'unknown') inputWarnings.push("weak provenance: last_revised 'unknown' — this DRAFT is non-releaseable until a real date is supplied (generate --check fails closed on it)");
  if (harnesses.length === 0) {
    throw new Error(`migrate: no known harness files provided (got [${allKeys.join(', ')}]; need one of ${KNOWN_HARNESSES.join(', ')})`);
  }
  // Count each normalized line across harnesses, preserving first-seen order.
  const counts = new Map();   // line → Set(harness)
  const order = [];
  const perHarnessLines = {};
  for (const h of harnesses) {
    perHarnessLines[h] = meaningfulLines(files[h]);
    for (const line of perHarnessLines[h]) {
      if (!counts.has(line)) { counts.set(line, new Set()); order.push(line); }
      counts.get(line).add(h);
    }
  }
  const shared = order.filter((l) => counts.get(l).size >= 2);
  const perHarnessUnique = {};
  for (const h of harnesses) perHarnessUnique[h] = perHarnessLines[h].filter((l) => counts.get(l).size === 1);

  // Build the draft contract.
  const fm = [
    '---',
    'schema_version: 1.0',
    `contract_id: ${contractId}`,
    `canonical_for: [${harnesses.map((h) => `"${h}"`).join(', ')}]`,
    `last_revised: ${lastRevised}`,
    '---',
  ].join('\n');

  const out = [fm, '', '# Project Contract', '',
    '> DRAFT — migrated from existing harness files. Review before adopting; then regenerate with generate-<harness>-md.mjs.', ''];
  out.push('## Project-Specific Rules', '');
  out.push(shared.length ? shared.join('\n') : '<!-- no shared content detected across harness files -->', '');
  out.push('## Harness-Specific Sections', '');
  for (const h of harnesses) {
    out.push(`### ${HARNESS_ONLY[h]}`, '');
    out.push(perHarnessUnique[h].length ? perHarnessUnique[h].join('\n') : `<!-- no ${h}-only content -->`, '');
  }

  return {
    draft: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    stats: { shared: shared.length, perHarness: Object.fromEntries(harnesses.map((h) => [h, perHarnessUnique[h].length])) },
    warnings: inputWarnings,
  };
}

function isMain() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const files = {};
  for (const [flag, h] of [['claude', 'claude-code'], ['codex', 'codex']]) {
    const p = opt(flag) || (existsSync(HARNESS_OUTPUT[h]) ? HARNESS_OUTPUT[h] : null);
    if (p && existsSync(p)) files[h] = readFileSync(p, 'utf8');
  }
  if (Object.keys(files).length === 0) { process.stderr.write('no harness files found (pass --claude/--codex)\n'); process.exit(1); }
  let r;
  try { r = migrateToContract({ files, contractId: opt('id') || 'project', lastRevised: opt('last-revised') || 'unknown' }); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
  (r.warnings || []).forEach((w) => process.stderr.write(`(warn) ${w}\n`));
  const writeTo = opt('write');
  if (writeTo) {
    // Never silently clobber an existing contract (review rule: draft-for-review, not overwrite).
    if (existsSync(writeTo) && !args.includes('--force')) {
      process.stderr.write(`refusing to overwrite existing ${writeTo} without --force (this is a DRAFT for review; protect the adopted contract)\n`);
      process.exit(1);
    }
    writeFileSync(writeTo, r.draft);
    process.stdout.write(`wrote DRAFT ${writeTo} (${r.stats.shared} shared lines) — review before adopting\n`);
  } else process.stdout.write(r.draft);
}
