/**
 * contract-format.mjs — v3.0 Instruction-Surface Adapter System: the shared core.
 *
 * One canonical `<project>/CONTRACT.md` is the authoritative source of agent
 * instructions; per-harness CLAUDE.md / AGENTS.md are GENERATED from it.
 * This module holds what all three generators share — the parser, the schema check, the
 * harness render, and the deterministic provenance header — so generate-claude-md /
 * agents-md stay thin (harness specifics are just the name + filename).
 *
 * The load-bearing property is DETERMINISM: the provenance `generated_at` is the
 * contract's `last_revised` (NOT wall-clock), and `contract_hash` is the sha256 of the
 * contract bytes — so the same contract regenerates byte-identically. That is what makes
 * `--check` drift detection meaningful (drift = a hand edit, never a timestamp).
 *
 * Per DC-77 ships as a script; per DC-80 .mjs only.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '1.0';
export const GENERATOR_VERSION = 'v3.0.0';
export const ADAPTER_VERSION = 'v3.0.0';
export const KNOWN_HARNESSES = ['claude-code', 'codex'];
export const HARNESS_OUTPUT = { 'claude-code': 'CLAUDE.md', codex: 'AGENTS.md' };
// The ## section per harness inside "## Harness-Specific Sections".
const HARNESS_ONLY_SUBSECTION = { 'claude-code': 'claude-code-only', codex: 'codex-only' };
const REQUIRED_FIELDS = ['schema_version', 'contract_id', 'canonical_for'];
const HARNESS_SPECIFIC_HEADING = 'Harness-Specific Sections';
const OVERRIDE_HOOKS_HEADING = 'Override Hooks';

export function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

// Minimal YAML frontmatter parse — scalars + one-line JSON-ish arrays. No dependency.
function parseFrontmatter(block) {
  const fm = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      val = val.replace(/^['"]|['"]$/g, '');
    }
    fm[key] = val;
  }
  return fm;
}

// Split markdown body into { '## heading text': 'body...' } and capture ### subsections
// of the Harness-Specific Sections block separately.
function parseSections(body) {
  const sections = {};
  const harnessOnly = {};
  const lines = body.split('\n');
  let current = null, inHarnessBlock = false, currentSub = null;
  const buf = {}, subBuf = {};
  const flush = () => { if (current) sections[current] = (buf[current] || []).join('\n').trim(); };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h2) {
      flush();
      current = h2[1];
      inHarnessBlock = current === HARNESS_SPECIFIC_HEADING;
      currentSub = null;
      buf[current] = [];
      continue;
    }
    if (h3 && inHarnessBlock) {
      currentSub = h3[1];
      subBuf[currentSub] = [];
      continue;
    }
    if (inHarnessBlock && currentSub) { subBuf[currentSub].push(line); continue; }
    if (current) buf[current].push(line);
  }
  flush();
  for (const [k, v] of Object.entries(subBuf)) harnessOnly[k] = v.join('\n').trim();
  return { sections, harnessOnly };
}

export function parseContract(contractPath) {
  const raw = readFileSync(contractPath, 'utf8').replace(/\r\n?/g, '\n'); // CRLF tolerance (review M1)
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error(`CONTRACT parse error: no YAML frontmatter in ${contractPath}`);
  const frontmatter = parseFrontmatter(fmMatch[1]);
  const body = fmMatch[2];

  for (const f of REQUIRED_FIELDS) {
    if (frontmatter[f] == null || frontmatter[f] === '') throw new Error(`CONTRACT invalid: missing required field '${f}'`);
  }
  if (String(frontmatter.schema_version) !== SCHEMA_VERSION) {
    throw new Error(`CONTRACT schema_version mismatch: expected ${SCHEMA_VERSION}, got ${frontmatter.schema_version}`);
  }
  const canonicalFor = Array.isArray(frontmatter.canonical_for) ? frontmatter.canonical_for : [frontmatter.canonical_for];
  const warnings = [];
  for (const h of canonicalFor) if (!KNOWN_HARNESSES.includes(h)) warnings.push(`unknown harness in canonical_for: '${h}' (no generator will emit for it)`);

  const { sections, harnessOnly } = parseSections(body);
  return { raw, frontmatter, canonicalFor, sections, harnessOnly, warnings };
}

export function parseOverrides(overridePath) {
  if (!overridePath || !existsSync(overridePath)) return { present: false, content: '', hash: 'none' };
  const raw = readFileSync(overridePath, 'utf8');
  // Hash the RAW bytes — a whitespace-only edit still changes the file and
  // must change override_block_hash. content is trimmed only for clean appending.
  return { present: true, content: raw.trim(), hash: sha256(raw) };
}

// Render the harness-facing markdown body (sans provenance header).
// Canonical sections (everything except the Harness-Specific block + Override Hooks) go
// to every harness; the matching <harness>-only subsection is appended for that harness.
export function renderForHarness(contract, harness, overrides = {}) {
  const out = ['# Project Contract', ''];
  for (const [heading, content] of Object.entries(contract.sections)) {
    if (heading === HARNESS_SPECIFIC_HEADING || heading === OVERRIDE_HOOKS_HEADING) continue;
    if (!content) continue;
    out.push(`## ${heading}`, '', content, '');
  }
  const sub = HARNESS_ONLY_SUBSECTION[harness];
  const harnessContent = sub ? contract.harnessOnly[sub] : null;
  if (harnessContent) out.push(`## ${harness} specifics`, '', harnessContent, '');
  let body = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const ov = overrides.present ? overrides : parseOverridesInline(overrides);
  if (ov && ov.present) {
    body += `\n<!-- BEGIN OVERRIDE — sourced from ${HARNESS_OUTPUT[harness]}.override -->\n${ov.content}\n<!-- END OVERRIDE -->\n`;
  }
  return body;
}
function parseOverridesInline(o) { return o && o.content ? { present: true, content: o.content, hash: o.hash || sha256(o.content) } : null; }

export function computeProvenance({ contract, overrides = {} }) {
  return {
    contract_path: './CONTRACT.md',
    contract_hash: sha256(contract.raw),
    generator_version: GENERATOR_VERSION,
    adapter_version: ADAPTER_VERSION,
    // DETERMINISTIC: contract.last_revised, never wall-clock.
    generated_at: contract.frontmatter.last_revised || 'unknown',
    override_block_hash: overrides && overrides.present ? overrides.hash : 'none',
  };
}

export function withProvenance(body, provenance) {
  const header = [
    '<!--',
    'GENERATED FROM CONTRACT — DO NOT EDIT BY HAND',
    `contract_path: ${provenance.contract_path}`,
    `contract_hash: ${provenance.contract_hash}`,
    `generator_version: ${provenance.generator_version}`,
    `adapter_version: ${provenance.adapter_version}`,
    `generated_at: ${provenance.generated_at}`,
    `override_block_hash: ${provenance.override_block_hash}`,
    '-->',
    '',
  ].join('\n');
  return header + '\n' + body;
}

// Shared generator body used by each generate-<harness>-md.mjs wrapper.
export async function generateForHarness({ harness, contractPath, outputPath, overridePath = null, mode = 'dry-run' }) {
  const contract = parseContract(contractPath);
  const overrides = parseOverrides(overridePath);
  const warnings = [...contract.warnings];
  // FATAL provenance issues — release-gate blockers (Hale item 2: the gate must FAIL
  // CLOSED on these, not just warn). They make check mode fail and are surfaced as
  // warnings in write/dry-run so local iteration still sees them.
  const fatal = [];
  if (!contract.canonicalFor.includes(harness)) {
    fatal.push(`harness '${harness}' is not in canonical_for [${contract.canonicalFor.join(', ')}] — generating an unintended surface`);
  }
  // Missing AND the literal 'unknown' are separate cases — both make generated_at
  // non-deterministic and must fail the gate closed.
  if (!contract.frontmatter.last_revised || contract.frontmatter.last_revised === 'unknown') {
    fatal.push(`contract last_revised is ${contract.frontmatter.last_revised ? "'unknown'" : 'missing'} — generated_at is non-deterministic, so --check drift is unreliable; supply a real date before release`);
  }
  warnings.push(...fatal);
  const body = renderForHarness(contract, harness, overrides);
  const provenance = computeProvenance({ contract, overrides });
  const full = withProvenance(body, provenance);

  if (mode === 'check') {
    const existing = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
    // Fail closed: drift OR a fatal provenance issue blocks the release gate.
    return { drift: existing !== full, fatal: fatal.length > 0, fatalErrors: fatal, warnings };
  }
  if (mode === 'write') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outputPath, full);
    return { written: outputPath, fatal: fatal.length > 0, fatalErrors: fatal, warnings };
  }
  return { wouldWrite: full, fatal: fatal.length > 0, fatalErrors: fatal, warnings };
}
