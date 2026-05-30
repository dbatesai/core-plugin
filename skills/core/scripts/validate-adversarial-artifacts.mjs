/**
 * validate-adversarial-artifacts.mjs — v2.9/v3.0 Slice E (validator half).
 *
 * Validates the structured artifacts CORE's anti-anchoring discipline produces:
 * initial-frame.json (per agent, Phase 1), persuasion-log.jsonl, mind-changes.jsonl.
 * These are how we know the adversarial process actually ran — an empty persuasion log
 * after adversarial phases means it probably didn't (schemas/output.md).
 *
 * Scope: this is the SPIKE-INDEPENDENT half of Slice E — it validates artifact shape, it
 * does NOT prove physical anti-anchoring isolation (that needs the staging-manifest +
 * empirical Workflow spike, gated on user opt-in). So this ships while R-17's PASS path
 * stays DEGRADED; nothing here claims R-17 closed.
 *
 * Schema: skills/core/schemas/adversarial-artifacts.md (the durable in-repo contract;
 * Hale-reviewed @ 5be7e6d, fix-forward applied — ts/schema_version checks, cross-artifact
 * agent integrity, advisory/authority mode). Honest policy: an EMPTY persuasion log is a
 * WARNING (process-suspect) in advisory mode and a hard FAIL in authority mode — a
 * genuinely uncontested run is rare but possible, and a hard fail would punish real
 * consensus.
 *
 * Per DC-77 ships as a script; per DC-80 .mjs only.
 *
 * CLI: node validate-adversarial-artifacts.mjs --frames a.json,b.json --persuasion p.jsonl --mind m.jsonl [--json]
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIDENCE_ENUM = new Set(['low', 'medium', 'high', 'foundational']);
export const SCHEMA_VERSION = '1.0';

function req(obj, fields, errors, ctx = '') {
  for (const f of fields) if (obj[f] === undefined || obj[f] === null || obj[f] === '') errors.push(`${ctx}missing required field '${f}'`);
}
function checkVersion(obj, errors) {
  if (obj.schema_version === undefined) errors.push("missing required field 'schema_version'");
  else if (String(obj.schema_version) !== SCHEMA_VERSION) errors.push(`schema_version '${obj.schema_version}' != '${SCHEMA_VERSION}'`);
}
function checkTs(obj, errors) {
  if (obj.ts !== undefined && obj.ts !== null && obj.ts !== '' && Number.isNaN(Date.parse(obj.ts))) errors.push(`ts not parseable: '${obj.ts}'`);
}

export function validateInitialFrame(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { valid: false, errors: ['initial-frame is not an object'] };
  req(obj, ['schema_version', 'agent', 'role', 'ts', 'frame'], errors);
  checkVersion(obj, errors);
  checkTs(obj, errors);
  // peer_exposure:false is a DECLARED invariant (self-asserted), NOT isolation proof — the
  // mechanical proof is the staging manifest. Still required: a frame self-claiming
  // post-peer-exposure is definitionally anchored.
  if (obj.peer_exposure !== false) errors.push('peer_exposure must be false (declared anti-anchoring invariant; mechanical proof is the staging manifest, not this field)');
  const frame = obj.frame || {};
  if (!Array.isArray(frame.key_claims) || frame.key_claims.length === 0) errors.push('frame.key_claims must be a non-empty array');
  if (frame.confidence !== undefined && !CONFIDENCE_ENUM.has(frame.confidence)) errors.push(`frame.confidence '${frame.confidence}' not in {${[...CONFIDENCE_ENUM].join(', ')}}`);
  return { valid: errors.length === 0, errors };
}

export function validatePersuasionLogLine(obj) {
  const errors = [];
  req(obj, ['ts', 'from_agent', 'to_agent', 'claim', 'shifted'], errors);
  checkVersion(obj, errors);
  checkTs(obj, errors);
  if (typeof obj.shifted !== 'boolean') errors.push("'shifted' must be a boolean");
  if (obj.shifted === true) req(obj, ['from_position', 'to_position'], errors, 'shifted=true: ');
  return { valid: errors.length === 0, errors };
}

export function validateMindChangeLine(obj) {
  const errors = [];
  req(obj, ['ts', 'agent', 'field', 'from', 'to', 'persuaded_by'], errors);
  checkVersion(obj, errors);
  checkTs(obj, errors);
  return { valid: errors.length === 0, errors };
}

// Validate a JSONL string with a per-line validator. Blank lines skipped; malformed lines
// reported with 1-based line numbers.
export function validateJsonl(content, perLine) {
  const errors = [];
  let count = 0;
  const lines = String(content || '').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let obj; try { obj = JSON.parse(line); } catch { errors.push(`line ${i + 1}: not valid JSON`); return; }
    const r = perLine(obj);
    if (!r.valid) r.errors.forEach((e) => errors.push(`line ${i + 1}: ${e}`));
    else count += 1;
  });
  return { valid: errors.length === 0, errors, count };
}

// Collect the agent ids that have an initial frame (for cross-artifact integrity).
function framedAgents(initialFrames) {
  return new Set(initialFrames.map((f) => f && f.agent).filter(Boolean));
}
// Parse JSONL lines leniently (validation errors are reported separately) to read agent refs.
function parseLines(content) {
  return String(content || '').split('\n').map((l, i) => { if (!l.trim()) return null; try { return { obj: JSON.parse(l), line: i + 1 }; } catch { return null; } }).filter(Boolean);
}

export function validateAdversarialArtifacts({ initialFrames = [], persuasionLog = '', mindChanges = '', mode = 'advisory' }) {
  const warnings = [];
  const crossErrors = [];
  const frameResults = initialFrames.map((f, i) => ({ idx: i, ...validateInitialFrame(f) }));
  const persuasion = validateJsonl(persuasionLog, validatePersuasionLogLine);
  const mind = validateJsonl(mindChanges, validateMindChangeLine);

  // Cross-artifact integrity (Hale): logs cannot name participants who never framed.
  // Only checkable when frames are present. 'self' is exempt in persuaded_by.
  const agents = framedAgents(initialFrames);
  if (agents.size > 0) {
    for (const { obj, line } of parseLines(persuasionLog)) {
      for (const ref of ['from_agent', 'to_agent']) if (obj[ref] && !agents.has(obj[ref])) crossErrors.push(`persuasion line ${line}: ${ref} '${obj[ref]}' has no initial frame`);
    }
    for (const { obj, line } of parseLines(mindChanges)) {
      if (obj.agent && !agents.has(obj.agent)) crossErrors.push(`mind-changes line ${line}: agent '${obj.agent}' has no initial frame`);
      if (obj.persuaded_by && obj.persuaded_by !== 'self' && !agents.has(obj.persuaded_by)) crossErrors.push(`mind-changes line ${line}: persuaded_by '${obj.persuaded_by}' has no initial frame`);
    }
  }

  // Empty-persuasion policy is MODE-dependent: advisory → warning; authority → hard fail.
  let emptyPersuasionFails = false;
  if (persuasion.count === 0) {
    if (mode === 'authority') { emptyPersuasionFails = true; crossErrors.push('authority mode: empty persuasion log after adversarial phases — blocked (claims Phase-3 pressure but recorded none)'); }
    else warnings.push('process-suspect: empty persuasion log — adversarial phases produced no recorded persuasion (legitimate only if the run was genuinely uncontested)');
  }
  // Hale: authority mode must HARD-FAIL zero initial frames — a run fed to a release/
  // authority gate with no Phase-1 frames cannot prove framing happened OR cross-check
  // participants. Advisory mode keeps it a warning.
  if (frameResults.length === 0) {
    if (mode === 'authority') crossErrors.push('authority mode: no initial-frame.json — cannot prove Phase-1 framing or cross-check participants; blocked for authority/release use');
    else warnings.push('no initial-frame.json provided — cannot confirm Phase-1 framing happened');
  }

  const valid = frameResults.every((r) => r.valid) && persuasion.valid && mind.valid && crossErrors.length === 0;
  return { valid, mode, warnings, crossErrors, initialFrames: frameResults, persuasionLog: persuasion, mindChanges: mind, emptyPersuasionFails };
}

function readIf(p) { return p && existsSync(p) ? readFileSync(p, 'utf8') : ''; }

function isMain() { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } }

if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const frames = (opt('frames') || '').split(',').filter(Boolean).map((p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { __unreadable: p }; } });
  const r = validateAdversarialArtifacts({ initialFrames: frames, persuasionLog: readIf(opt('persuasion')), mindChanges: readIf(opt('mind')), mode: opt('mode') || 'advisory' });
  if (args.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write(`adversarial-artifacts (${r.mode}): ${r.valid ? 'VALID' : 'INVALID'}\n`);
    r.warnings.forEach((w) => process.stdout.write(`  (warn) ${w}\n`));
    r.crossErrors.forEach((e) => process.stdout.write(`  cross: ${e}\n`));
    r.initialFrames.filter((f) => !f.valid).forEach((f) => f.errors.forEach((e) => process.stdout.write(`  frame[${f.idx}]: ${e}\n`)));
    r.persuasionLog.errors.forEach((e) => process.stdout.write(`  persuasion: ${e}\n`));
    r.mindChanges.errors.forEach((e) => process.stdout.write(`  mind-changes: ${e}\n`));
  }
  process.exit(r.valid ? 0 : 1);
}
