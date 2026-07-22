#!/usr/bin/env node
/**
 * mailbox-nudge-hook.mjs — UserPromptSubmit companion hook that surfaces the
 * current project's own _mailbox/ unread count on every turn.
 *
 * Why a separate hook file, not folded into retrieve-context-hook.mjs: that
 * hook's exact injected text is the tracked surface of an active
 * memory-efficacy pilot (corpus-leakage and identity checks key off its
 * precise pack/directive content) -- adding unrelated content to it mid-trial
 * risks invalidating that measurement. This hook is a fully independent
 * UserPromptSubmit registration (see hooks.json) with its own isolated
 * stdout; it never reads from or writes into retrieve-context-hook.mjs's
 * code path.
 *
 * Motivation: PROJECT.md names a mailbox-monitoring gap (five documented
 * instances of an agent going multiple sessions without checking
 * `_mailbox/`) and a structural fix -- "surfacing the unread count
 * automatically" -- as named but not yet built. This is that fix.
 *
 * Scope: this project's OWN _mailbox/ only, per references/mailbox.md's
 * documented per-project inbox. It intentionally does NOT know about
 * sibling advisor-project mailboxes some multi-agent workflows use --
 * naming specific sibling project paths in shipped code would be exactly
 * the core-vs-extension leak DC-102 forbids (core ships the capability,
 * a workflow's own project layout is its own business).
 *
 * Fail-open and silent by default: no _mailbox/ directory, or zero unread
 * messages, produces no output at all -- a no-op for the majority of /core
 * installs that never touch the mailbox feature.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listMessages } from '../scripts/mailbox.mjs';

export function buildNudge(count) {
  if (!count) return '';
  const plural = count === 1 ? 'message' : 'messages';
  return `CORE mailbox: ${count} unread ${plural} in _mailbox/ — check before proceeding.\n`;
}

export function main() {
  let payload = {};
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }
  const store = payload.cwd || process.cwd();
  let count = 0;
  try { count = listMessages(store).length; } catch { count = 0; }
  const nudge = buildNudge(count);
  if (nudge) process.stdout.write(nudge);
  return 0;
}

// Only run as the hook entry — importing this module must not execute main() / process.exit().
const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  try { process.exit(main() || 0); } catch { process.exit(0); }
}
