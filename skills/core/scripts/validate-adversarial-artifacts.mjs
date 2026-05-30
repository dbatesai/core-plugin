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
 * Schema per docs/specs/2026-05-30-adversarial-artifact-schema-proposal.md (proposed to
 * Hale; build-then-review — fix-forward if Hale ratifies different fields). Honest policy
 * call: an EMPTY persuasion log is a WARNING (process-suspect), not a hard fail — a
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

function req(obj, fields, errors, ctx = '') {
  for (const f of fields) if (obj[f] === undefined || obj[f] === null || obj[f] === '') errors.push(`${ctx}missing required field '${f}'`);
}

export function validateInitialFrame(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { valid: false, errors: ['initial-frame is not an object'] };
  req(obj, ['schema_version', 'agent', 'role', 'ts', 'frame'], errors);
  if (obj.peer_exposure !== false) errors.push("peer_exposure must be false (the anti-anchoring guarantee — a frame formed after peer exposure is anchored)");
  if (obj.ts && Number.isNaN(Date.parse(obj.ts))) errors.push(`ts not parseable: '${obj.ts}'`);
  const frame = obj.frame || {};
  if (!Array.isArray(frame.key_claims) || frame.key_claims.length === 0) errors.push('frame.key_claims must be a non-empty array');
  if (frame.confidence !== undefined && !CONFIDENCE_ENUM.has(frame.confidence)) errors.push(`frame.confidence '${frame.confidence}' not in {${[...CONFIDENCE_ENUM].join(', ')}}`);
  return { valid: errors.length === 0, errors };
}

export function validatePersuasionLogLine(obj) {
  const errors = [];
  req(obj, ['ts', 'from_agent', 'to_agent', 'claim', 'shifted'], errors);
  if (typeof obj.shifted !== 'boolean') errors.push("'shifted' must be a boolean");
  if (obj.shifted === true) req(obj, ['from_position', 'to_position'], errors, 'shifted=true: ');
  return { valid: errors.length === 0, errors };
}

export function validateMindChangeLine(obj) {
  const errors = [];
  req(obj, ['ts', 'agent', 'field', 'from', 'to', 'persuaded_by'], errors);
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

export function validateAdversarialArtifacts({ initialFrames = [], persuasionLog = '', mindChanges = '' }) {
  const warnings = [];
  const frameResults = initialFrames.map((f, i) => {
    const r = validateInitialFrame(f);
    return { idx: i, ...r };
  });
  const persuasion = validateJsonl(persuasionLog, validatePersuasionLogLine);
  const mind = validateJsonl(mindChanges, validateMindChangeLine);

  // Honest policy: empty persuasion log after adversarial phases is SUSPECT (output.md:
  // "empty Persuasion Log → process probably didn't work"), surfaced as a warning.
  if (persuasion.count === 0) warnings.push('process-suspect: empty persuasion log — adversarial phases produced no recorded persuasion (legitimate only if the run was genuinely uncontested)');
  if (frameResults.length === 0) warnings.push('no initial-frame.json provided — cannot confirm Phase-1 framing happened');

  const valid = frameResults.every((r) => r.valid) && persuasion.valid && mind.valid;
  return { valid, warnings, initialFrames: frameResults, persuasionLog: persuasion, mindChanges: mind };
}

function readIf(p) { return p && existsSync(p) ? readFileSync(p, 'utf8') : ''; }

function isMain() { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } }

if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const frames = (opt('frames') || '').split(',').filter(Boolean).map((p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { __unreadable: p }; } });
  const r = validateAdversarialArtifacts({ initialFrames: frames, persuasionLog: readIf(opt('persuasion')), mindChanges: readIf(opt('mind')) });
  if (args.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write(`adversarial-artifacts: ${r.valid ? 'VALID' : 'INVALID'}\n`);
    r.warnings.forEach((w) => process.stdout.write(`  (warn) ${w}\n`));
    r.initialFrames.filter((f) => !f.valid).forEach((f) => f.errors.forEach((e) => process.stdout.write(`  frame[${f.idx}]: ${e}\n`)));
    r.persuasionLog.errors.forEach((e) => process.stdout.write(`  persuasion: ${e}\n`));
    r.mindChanges.errors.forEach((e) => process.stdout.write(`  mind-changes: ${e}\n`));
  }
  process.exit(r.valid ? 0 : 1);
}
