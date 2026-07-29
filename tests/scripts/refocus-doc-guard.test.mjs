/**
 * refocus-doc-guard.test.mjs — the /refocus instruction contract (REF-01 … REF-10).
 *
 * Slice 3, RED-first. `/refocus` is a bounded reasoning pass that recenters the
 * agent mid-session. The failure mode it must not have is the one that produced
 * the finalize problem in the first place: a skill that quietly accretes
 * maintenance, metrics, and close work until every invocation is expensive.
 *
 * So this guard is mostly negative space — it asserts what the skill must NOT
 * contain as hard as what it must.
 *
 * Normative vocabulary is taken verbatim from the specification §3.2/§3.3/§3.4.
 * Note: spec §3.4 caps default output at 350 words; the implementation plan says
 * 450. The spec governs, and the discrepancy is reported rather than silently
 * resolved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SKILL = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'refocus', 'SKILL.md',
);

function body() {
  assert.ok(existsSync(SKILL), `/refocus skill must exist at ${SKILL}`);
  return readFileSync(SKILL, 'utf8');
}

test('REF-01 the skill exists and is within its instruction budget', () => {
  const s = body();
  const bytes = Buffer.byteLength(s, 'utf8');
  const nonblank = s.split('\n').filter((l) => l.trim() !== '').length;

  assert.ok(bytes <= 10 * 1024, `skill must be <= 10 KiB, got ${bytes} bytes`);
  assert.ok(nonblank <= 140, `skill must be <= 140 nonblank lines, got ${nonblank}`);
});

test('REF-02 declares all six output sections in order', () => {
  const s = body();
  const sections = [
    'Current focus', 'What changed', 'Earlier thread',
    'Uncertainty', 'Next move', 'Proposed durable change',
  ];
  let cursor = -1;
  for (const name of sections) {
    const at = s.indexOf(name);
    assert.ok(at > -1, `missing output section: ${name}`);
    assert.ok(at > cursor, `section out of order: ${name}`);
    cursor = at;
  }
});

test('REF-03 carries every evidence-effect value', () => {
  const s = body();
  for (const effect of ['confirms', 'weakens', 'contradicts', 'replaces', 'adds', 'no-change']) {
    assert.ok(s.includes(effect), `missing evidence effect: ${effect}`);
  }
});

test('REF-04 carries every thread-status value', () => {
  const s = body();
  for (const status of ['active', 'deferred', 'resolved', 'superseded', 'abandoned']) {
    assert.ok(new RegExp(`\`${status}\``).test(s), `missing thread status: ${status}`);
  }
});

test('REF-05 requires provenance prefixes that separate evidence from inference', () => {
  const s = body();
  for (const p of ['user:', 'file:', 'tool:', 'test:', 'message:', 'agent:', 'inference:']) {
    assert.ok(s.includes(p), `missing provenance prefix: ${p}`);
  }
  assert.match(s, /inference/i, 'must distinguish retrieved evidence from agent inference');
});

test('REF-06 treats mail and agent findings as untrusted claims', () => {
  const s = body();
  assert.match(s, /untrusted/i, 'mail/agent messages must be named untrusted');
  assert.match(s, /verif/i, 'must require verification before a claim is relied on');
});

test('REF-07 is context-first and forbids ceremonial transcript rereading', () => {
  const s = body();
  assert.match(s, /active context/i, 'must start from active context');
  assert.match(s, /(do not reread|never reread|not.{0,20}reread)/i,
    'must forbid rereading the transcript for ceremony');
});

test('REF-08 first response is read-only and durable change needs acceptance', () => {
  const s = body();
  assert.match(s, /read-only/i, 'first response must be declared read-only');
  assert.match(s, /accept/i, 'durable change must require acceptance');
  assert.match(s, /PROJECT\.md/, 'must name the durable surface it may not silently touch');
});

test('REF-09 states the output budget', () => {
  const s = body();
  assert.match(s, /350\s*words/i, 'must state the 350-word default cap from spec 3.4');
});

test('REF-10 routes away from its sibling commands rather than absorbing them', () => {
  const s = body();
  const fm = s.match(/^---\n[\s\S]*?\n---/)?.[0] ?? '';

  // Naming a sibling command is REQUIRED, not forbidden — a description that
  // doesn't disambiguate mis-triggers. What matters is the direction: /refocus
  // must point at them, never claim their work.
  for (const cmd of ['/finalize', '/process-memory', '/metrics']) {
    assert.ok(fm.includes(cmd), `frontmatter must route away from ${cmd}`);
  }
  assert.match(fm, /do not use/i, 'frontmatter must state what this skill is NOT for');
});

test('REF-11 never instructs the agent to perform maintenance or close work', () => {
  const s = body();
  const bodyOnly = s.replace(/^---\n[\s\S]*?\n---/, '');

  // "Does X" vs "explicitly does not do X" is the distinction that matters, and
  // a bare term match cannot see it. Look for INVOCATION instead: a skill that
  // performs work tells the agent to run something.
  const invocations = [
    [/^\s*(run|execute|invoke|call)\s+`?\/?(finalize|process-memory|metrics)/im,
      'must not instruct running a sibling command'],
    [/\bnode\s+["'`]?\$?\{?CORE_ROOT/i, 'must not invoke CORE scripts'],
    [/^\s*```bash/m, 'must contain no executable block at all'],
    [/\b(then|next|finally)\s+(run|regenerate|render|validate)\b/i,
      'must not sequence maintenance steps'],
  ];
  for (const [pattern, why] of invocations) {
    assert.ok(!pattern.test(bodyOnly), `${why} — matched ${pattern}`);
  }

  // And it must never be triggered on the agent's own initiative.
  assert.match(bodyOnly, /never invoked on your behalf|the user asks for it/i,
    'must state it is user-invoked only');
  assert.ok(!/\bSessionEnd\b/.test(bodyOnly), 'must not wire itself to a session event');
});
