/**
 * hardware-budget.mjs — cross-platform memory probe for multi-agent sizing.
 *
 * Replaces the macOS-only `sysctl -n hw.memsize` that protocols/execution.md
 * referenced (it fails on Linux and doesn't exist on Windows, silently leaving
 * the agent with no memory budget — SYN-003 merging PROTO-007 / HARNESS-009 /
 * SKILL-020). os.totalmem() is cross-platform and zero-dependency.
 *
 * Prints exactly one line:  memory_gb=<n> profile=<slug> max_agents=<n>
 * Thresholds mirror the table in protocols/execution.md §"Hardware budget" —
 * if one moves, move both.
 *
 * The script ships with the plugin by design. Node.js (.mjs) only, zero dependencies.
 */

import { totalmem } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function classifyHardware(totalBytes) {
  const gb = Math.round(totalBytes / (1024 ** 3));
  if (gb >= 48) return { gb, profile: 'Context Hoarder', max_agents: 8 };
  if (gb >= 24) return { gb, profile: 'Streamlined Thinker', max_agents: 5 };
  return { gb, profile: 'Minimal Mode', max_agents: 3 };
}

export function main() {
  const { gb, profile, max_agents } = classifyHardware(totalmem());
  const slug = profile.toLowerCase().replace(/ /g, '-');
  process.stdout.write(`memory_gb=${gb} profile=${slug} max_agents=${max_agents}\n`);
  return 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_cliEntryCanonical(process.argv[1]) === _cliEntryCanonical(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
