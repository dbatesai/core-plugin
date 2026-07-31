/**
 * cli-entry.mjs — THE "am I being run directly?" check for every CLI script.
 *
 * Entry detection must survive path-spelling divergence: Node realpaths the
 * ESM entry by default (--preserve-symlinks-main off), so import.meta.url
 * carries the REAL path while process.argv[1] carries whatever spelling the
 * caller used. A symlinked or case-variant component makes a naive as-spelled
 * comparison false — and the CLI then silently does not run: exit 0, empty
 * stdout, empty stderr, a vanished error a supervisor reads as success.
 *
 * isCliEntry compares import.meta.url against BOTH the as-spelled and the
 * realpathed spellings of argv[1], so direct execution is recognized under
 * either symlink mode (default or --preserve-symlinks-main).
 *
 * ONE owner, shared by every entry-guarded script: hand-copied guards drift
 * (one copy shipped with a canonicalizer that never resolved symlinks).
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isCliEntry(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const hrefs = [];
  try { hrefs.push(pathToFileURL(resolve(argv1)).href); } catch { /* unresolvable spelling */ }
  try { hrefs.push(pathToFileURL(realpathSync(argv1)).href); } catch { /* no such file */ }
  const hit = hrefs.includes(importMetaUrl);
  // The documented silent-no-op diagnostic (startup.md names this flag): when a
  // script appears to do nothing, this shows exactly which spellings failed to
  // match its module URL. Lived per-file before the guards converged here.
  if (!hit && process.env.CORE_DEBUG_CLI_ENTRY === '1') {
    process.stderr.write(`cli-entry: not the entry point — import.meta.url=${importMetaUrl} argv1Hrefs=${JSON.stringify(hrefs)}\n`);
  }
  return hit;
}
