/**
 * log-event.mjs — shared structured-logging helper.
 *
 * Phase 1b substrate per David's 2026-05-24 reframe: PROJECT.md management
 * is agent-managed; effectiveness is measured via structured event emission,
 * not user review. This helper centralizes the JSONL append discipline used
 * by hot-section.mjs (retrieval-log.jsonl) and demote-moves.mjs +
 * compact-project.mjs (hygiene-log.jsonl).
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { logEvent, eventLogPath } from './log-event.mjs';
 *   logEvent('<project>', 'hygiene-log.jsonl', { kind: 'demote-moves', ... });
 *
 * Failure mode discipline: silent skip when projectDir doesn't exist. Hosts
 * that emit events shouldn't crash if their target dir is misconfigured —
 * the missing log will surface separately when the analyzer runs.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function eventLogPath(projectDir, filename, { today } = {}) {
  const date = today || todayUTC();
  return join(projectDir, '_sessions', date, filename);
}

export function logEvent(projectDir, filename, event, { today, now } = {}) {
  if (!existsSync(projectDir)) return;
  const date = today || todayUTC();
  const sessionDir = join(projectDir, '_sessions', date);
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch { return; }
  const ts = now || new Date().toISOString();
  const record = { ts, ...event };
  try {
    appendFileSync(join(sessionDir, filename), JSON.stringify(record) + '\n');
  } catch {
    // Don't crash hosts on disk errors — emit is best-effort by design.
  }
}
