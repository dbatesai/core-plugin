import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hale's C/D PR-hardening ask: the adapter modernization (Slices C+D) is prose, so a
// regression here is silent. These guards assert the load-bearing mappings stay present
// — they catch an accidental revert of the Workflow/Teams split, the ScheduleWakeup
// dynamic-cadence answer, or the Codex schedule drop (the DC-75 parity boundary).
const HARNESSES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'harnesses');
const claudeMd = readFileSync(join(HARNESSES, 'claude-code.md'), 'utf8');
const codexMd = readFileSync(join(HARNESSES, 'codex.md'), 'utf8');

function section(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return '';
  const end = lines.slice(start + 1).findIndex((l) => /^## /.test(l));
  return lines.slice(start, end === -1 ? undefined : start + 1 + end).join('\n');
}

test('claude-code.md spawn-team maps BOTH Workflow (fan-out) and TeamCreate (Phase 3)', () => {
  const s = section(claudeMd, 'spawn-team');
  assert.ok(s.includes('Workflow'), 'Workflow substrate for isolated fan-out');
  assert.ok(s.includes('TeamCreate'), 'TeamCreate for multi-round adversarial pressure');
  assert.ok(/SendMessage/.test(s), 'Phase-3 inter-agent messaging named');
});

test('claude-code.md keeps anti-convergence discipline in core prose, not the adapter', () => {
  const s = section(claudeMd, 'spawn-team');
  assert.ok(/analysis\.md/.test(s), 'discipline points to protocols/analysis.md (core prose)');
});

test('claude-code.md schedule names ScheduleWakeup for dynamic cadence', () => {
  const s = section(claudeMd, 'schedule');
  assert.ok(s.includes('ScheduleWakeup'), 'ScheduleWakeup is the dynamic-cadence answer');
});

test('claude-code.md spawn-subagent offers worktree isolation + a subagent_type catalog', () => {
  const s = section(claudeMd, 'spawn-subagent');
  assert.ok(/isolation:\s*['"]worktree['"]/.test(s), 'worktree isolation documented');
  assert.ok(s.includes('Explore'), 'subagent_type catalog present');
});

test('codex.md preserves the schedule DROP (DC-75 parity boundary)', () => {
  const s = section(codexMd, 'schedule');
  assert.ok(/DROP/i.test(s), 'Codex schedule remains a documented drop');
});
