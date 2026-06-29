#!/usr/bin/env node
/**
 * retrieve-context-hook.mjs — per-turn retrieval injection (DC-94a, Gate G2).
 *
 * A UserPromptSubmit hook entry. When enabled, it runs the deterministic retriever
 * (retrieve-context.mjs) over the incoming user prompt and prints the top-3 matching
 * unit summaries to stdout, which Claude Code injects into the turn's context — so the
 * most relevant stored facts are in front of the agent every turn, not just at bootstrap.
 *
 * SHIPPED DEFAULT-ON, OPT-OUT (Gate G2 resolved, 2026-06-28). Registered in the plugin
 * manifest (hooks/hooks.json) as a UserPromptSubmit hook, so it is live on install. It
 * runs every turn unless the user sets CORE_RETRIEVAL_HOOK=0 (mirrors the DC-107 metrics
 * opt-out). Rationale: a default-off, manually-wired hook is invisible machinery no real
 * user would enable — the north-star ("never fail to retrieve") is only served if it's
 * actually live, and only then can the metrics layer measure whether injection helps.
 * Known limit (DC-111): lexical matching can inject a topical-but-irrelevant unit on an
 * abstract query (O1 noise) — bounded (byte-capped, advisory, fail-open) and the reasoning
 * tier is the sequenced de-noiser. To opt out:
 *
 *   // ~/.claude/settings.json  (or set the env var)
 *   CORE_RETRIEVAL_HOOK=0
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
  // Default-ON, opt-out gate (G2 shipped on, 2026-06-28). Runs unless explicitly
  // disabled with CORE_RETRIEVAL_HOOK=0 (mirrors the DC-107 metrics opt-out).
  if (process.env.CORE_RETRIEVAL_HOOK === '0') return 0;

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
