// startup-doc-contract.test.mjs — executable-contradiction guards for the
// startup protocol. These lock the audited defects closed: a nonexistent
// script path in the readiness command, error suppression contradicting the
// "failures remain visible" prose, a hardcoded Claude-only memory path handed
// to every harness, the buried view-memory ordering, and the duplicated
// bootstrap-dedup definition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core');
const startup = readFileSync(join(CORE, 'protocols', 'startup.md'), 'utf8');
const skill = readFileSync(join(CORE, 'SKILL.md'), 'utf8');

test('every startup index-registry invocation names the SHIPPED path (skills/core/scripts)', () => {
  assert.doesNotMatch(startup, /<CORE_ROOT>\/scripts\/index-registry\.mjs/,
    'the readiness command must not name the nonexistent <CORE_ROOT>/scripts/ path');
  assert.match(startup, /<CORE_ROOT>\/skills\/core\/scripts\/index-registry\.mjs/,
    'the record-the-bootstrap command names the shipped location');
});

test('metrics-init failure is visible: no stderr/exit suppression, and a typed failure marker line exists', () => {
  assert.doesNotMatch(startup, /metrics-init\.mjs[^\n]*2>&1[^\n]*\|\|\s*true/,
    'the scaffold call must not discard stderr and the exit code together');
  assert.match(startup, /CORE-METRICS-INIT-FAILED/,
    'a failed scaffold prints a visible marker the readiness summary carries');
});

test('capability probe failure is visible: no 2>/dev/null on the probe, and a typed failure marker line exists', () => {
  assert.doesNotMatch(startup, /capability-probe\.mjs --startup --json 2>\/dev\/null/,
    'the probe must not suppress the stderr the protocol itself says to leave visible');
  assert.match(startup, /CORE-CAPABILITY-PROBE-FAILED/);
});

test('the context-integrity command is harness-aware — no hardcoded Claude-only MEMORY.md path', () => {
  assert.doesNotMatch(startup, /--memory ~\/\.claude\/projects/,
    'check-context-integrity resolves the surface per harness; the Claude path must not be hardcoded for every harness');
  assert.match(startup, /explicitly skipped/,
    'the protocol names the Codex behavior: absent surface = explicit skip, not a false check');
});

test('view-memory leads the compose section — before the probe/scaffold/tripwire actions, not buried after them', () => {
  const composeAt = startup.indexOf('## Compose the readiness summary');
  assert.ok(composeAt >= 0);
  const viewAt = startup.indexOf('**First — view memory.**');
  const probeAt = startup.indexOf('capability-probe.mjs', composeAt);
  assert.ok(viewAt > composeAt, 'view-memory lives in the compose section');
  assert.ok(viewAt < probeAt, 'view-memory comes BEFORE the probe and every other compose-time action');
  assert.doesNotMatch(startup, /\*\*Before composing — view memory\.\*\*/,
    'the old buried duplicate is gone');
});

test('the bootstrap-dedup check is defined ONCE — startup.md owns it; SKILL.md points without restating', () => {
  assert.match(startup, /The check, in order:/, 'the authoritative enumeration stays in startup.md');
  assert.doesNotMatch(skill, /treat bootstrap as not-yet-run and run the protocol —/,
    'SKILL.md no longer restates the fallback rule');
  assert.doesNotMatch(skill, /`session_started_at` matches the timestamp/,
    'SKILL.md no longer restates the timestamp-match rule');
  assert.match(skill, /§"Bootstrap dedup"/, 'SKILL.md keeps the pointer to the single definition');
});
