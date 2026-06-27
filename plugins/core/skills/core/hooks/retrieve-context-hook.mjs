#!/usr/bin/env node
/**
 * retrieve-context-hook.mjs — per-turn retrieval injection (DC-94a, Gate G2).
 *
 * A UserPromptSubmit hook entry. When enabled, it runs the deterministic retriever
 * (retrieve-context.mjs) over the incoming user prompt and prints the top-3 matching
 * unit summaries to stdout, which Claude Code injects into the turn's context — so the
 * most relevant stored facts are in front of the agent every turn, not just at bootstrap.
 *
 * SHIPPED DEFAULT-OFF (Gate G2). The hook is a no-op unless CORE_RETRIEVAL_HOOK=1.
 * It is intentionally NOT registered in the plugin manifest (hooks/hooks.json) — the
 * plugin has shipped no manifest hooks since v3.2.0, and turning per-turn injection on
 * by default is David's call on the Task 11 precision evidence (top-N is tunable). To
 * opt in, a user adds a UserPromptSubmit hook to their settings pointing at this script
 * and sets CORE_RETRIEVAL_HOOK=1:
 *
 *   // ~/.claude/settings.json
 *   "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command",
 *     "command": "CORE_RETRIEVAL_HOOK=1 node <plugin>/skills/core/hooks/retrieve-context-hook.mjs" }] }] }
 *
 * I/O contract: reads the UserPromptSubmit payload as JSON on stdin (uses `.prompt`;
 * store path from CORE_RETRIEVAL_STORE, else payload `.cwd`, else process.cwd()).
 * Output is byte-capped. Any error is swallowed to a clean exit 0 — a retrieval hook
 * must never block the user's turn.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { readFileSync } from 'node:fs';
import { retrieveContext } from '../scripts/retrieve-context.mjs';

const OUTPUT_BYTE_CAP = 2048;
const TOP_N = 3;

async function main() {
  // Default-off gate (G2). No work, no output unless explicitly enabled.
  if (process.env.CORE_RETRIEVAL_HOOK !== '1') return 0;

  let payload = {};
  // Read stdin synchronously via fd 0 (works under execFileSync's input pipe).
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const prompt = String(payload.prompt || '');
  if (!prompt.trim()) return 0;

  const store = process.env.CORE_RETRIEVAL_STORE || payload.cwd || process.cwd();

  let hits = [];
  try { hits = retrieveContext(prompt, store, { topN: TOP_N }); } catch { return 0; }
  if (!hits.length) return 0;

  let out = 'Relevant stored context (CORE per-turn retrieval):\n';
  for (const h of hits) {
    const line = `- ${h.id}: ${h.summary}\n`;
    if (Buffer.byteLength(out + line, 'utf8') > OUTPUT_BYTE_CAP) break;
    out += line;
  }
  process.stdout.write(out);
  return 0;
}

main().then((code) => process.exit(code || 0)).catch(() => process.exit(0));
