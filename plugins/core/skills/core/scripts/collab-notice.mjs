/**
 * collab-notice.mjs — the one-shot notice the background collab sync leaves for the next turn.
 *
 * Kept apart from core-collab-sync.mjs so the per-turn retrieval hook can read it without
 * loading the intake code. The notice lives in the project's hot state (stateDir, never a
 * hand-built path), holds at most three readiness lines, and is removed as it is read.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, detectStateHarness } from './project-state.mjs';

const NOTICE = 'collab-handoff-notice.json';
export const hotDir = (project, env = process.env) => stateDir({ root: project, harness: detectStateHarness(env), kind: 'hot', forWrite: true }).dir;

/** Keep the readiness lines of the latest background run for the next foreground turn; clear when quiet. */
export function writeNotice(project, lines, { dir = hotDir(project), now = new Date().toISOString() } = {}) {
  const p = join(dir, NOTICE);
  if (!lines.length) { rmSync(p, { force: true }); return; }
  writeFileSync(p, JSON.stringify({ at: now, lines }) + '\n');
}

/** The pending notice, removed as it is read so it is shown once. Null when there is none. */
export function takeNotice(project, { dir } = {}) {
  try {
    dir ??= stateDir({ root: project, harness: detectStateHarness(), kind: 'hot' })?.dir;
    if (!dir) return null;
    const p = join(dir, NOTICE);
    if (!existsSync(p)) return null;
    const n = JSON.parse(readFileSync(p, 'utf8'));
    rmSync(p, { force: true });
    return Array.isArray(n.lines) && n.lines.length ? n.lines.slice(0, 3).map(String) : null;
  } catch { return null; }
}

