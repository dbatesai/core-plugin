/**
 * producer-identity.mjs — ONE owner for "which build wrote this row".
 *
 * Reads version + source_sha from the plugin manifest
 * (plugins/core/.claude-plugin/plugin.json) once at module load, mirroring the
 * pattern retrieve-context-hook.mjs established (2026-07-18 self-identifying
 * build SHA spec). 'unknown' is honest for any build that isn't
 * release-stamped (a --scope local dev install, or a manifest predating
 * source_sha). New row producers (self-test log, retrieval rows, turn-capture
 * evidence, scorecards, judgments) import THIS instead of hand-rolling another
 * manifest read — the guard-consolidation ratchet's "fixed once, never swept"
 * lesson applied at birth rather than after the audit.
 *
 * Ships with the plugin as prescriptive code; .mjs only.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'),
      'utf8',
    ));
  } catch { return {}; }
})();

export const PRODUCER_VERSION = String(MANIFEST.version || 'unknown');
export const PRODUCER_SHA = String(MANIFEST.source_sha || 'unknown');

/** Both fields as a spreadable object: `{ ...producerIdentity() }`. */
export function producerIdentity() {
  return { producer_version: PRODUCER_VERSION, producer_sha: PRODUCER_SHA };
}
