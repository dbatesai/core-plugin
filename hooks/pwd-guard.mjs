/**
 * PreToolUse hook: remind the agent to declare `intent: skill-edit` when writing
 * to CORE skill-product surfaces.
 *
 * Matches two install shapes:
 *   - Plugin install: ~/.claude/plugins/cache/<marketplace>/core/<version>/skills/core/**
 *   - Legacy direct install: ~/.claude/skills/core/**
 *
 * Reads stdin as JSON per Claude Code's PreToolUse hook contract; outputs an
 * additionalContext reminder if the write target is in skill-product scope.
 * Always exits 0 (advisory, not blocking).
 *
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

import { createInterface } from 'node:readline';

const SKILL_PATHS = [
  '/.claude/skills/core/',
  '/skills/core/',
];

async function main() {
  let raw = '';
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) raw += line + '\n';

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const filePath = (data?.tool_input?.file_path) || '';
  if (!SKILL_PATHS.some(p => filePath.includes(p))) process.exit(0);

  const context = [
    `SKILL-PRODUCT WRITE DETECTED: ${filePath}`,
    'Per data-storage protocol (DC-24), skill-product writes require a Pre-Write Declaration:',
    '  Writing to: <abs path> — category: skill product — naming: <convention> — rationale: <≤80c>',
    '  intent: skill-edit',
    'If this write is intentional skill editing, declare PWD with intent: skill-edit and proceed.',
    'If this destination is wrong, reconsider — see protocols/data-storage.md §"What lives where" for the three-surface model.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  }));
  process.exit(0);
}

main();
