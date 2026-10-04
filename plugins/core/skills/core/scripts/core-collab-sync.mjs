#!/usr/bin/env node
/**
 * core-collab-sync.mjs — land the outcome of every closed collab this project's participant joined.
 *
 * Optional: with no collab install it does nothing and says why. It reads collab only through
 * collab's documented CLI (`collab-outcome.mjs`, pure), never collab's files. What is owed is
 * recomputed from durable state on every run — a collab whose anchored ledger holds a close and
 * whose receipt the project lacks — so a crash at any point leaves it visible and the next run
 * finishes it. Run at session start and on each run of the session's loop.
 *
 * Each collab reports one state: landed · already-landed · open · not-joined ·
 * refused:<reason> · pending:<reason>. Every run appends its states to
 * <project>/_sessions/<date>/handoff-log.jsonl.
 *
 * CLI: node core-collab-sync.mjs <project> --participant <triplet>
 *        [--collab-cli <collab scripts dir>] [--collab-root <localhost collabs dir>]
 *   --collab-cli defaults to $COLLAB_SCRIPTS_DIR; --collab-root to $COLLAB_LOCAL_ROOT or ~/.collab/local.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from './cli-entry.mjs';
import { landObservation, sha256 } from './land-observation.mjs';

export function syncCollab(project, { land = landObservation, participant, collabCli = process.env.COLLAB_SCRIPTS_DIR, collabRoot = process.env.COLLAB_LOCAL_ROOT || join(homedir(), '.collab', 'local'), now = new Date().toISOString() } = {}) {
  const outcomeCli = collabCli ? join(collabCli, 'collab-outcome.mjs') : null;
  if (!outcomeCli || !existsSync(outcomeCli)) return { status: 'skipped', reason: 'collab is not installed (no collab-outcome.mjs found)', items: [] };
  if (!participant) return { status: 'skipped', reason: 'no participant identity given', items: [] };
  if (!existsSync(collabRoot)) return { status: 'ok', items: [] };

  const items = [];
  for (const name of readdirSync(collabRoot).sort()) {
    const dir = join(collabRoot, name);
    const r = spawnSync(process.execPath, [outcomeCli, dir, '--participant', participant], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    let report = null;
    try { report = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (r.status !== 0 || !report) { items.push({ collab: name, state: 'refused:render-failed', detail: (r.stderr || '').trim().slice(0, 300) }); continue; }
    if (report.status === 'refused') { items.push({ collab: name, state: `refused:${report.refusals.join(',')}` }); continue; }
    if (!report.joined) { items.push({ collab: name, state: 'not-joined' }); continue; }
    if (report.status !== 'closed') { items.push({ collab: name, state: 'open', unanchored: report.unanchored }); continue; }

    const bytes = Buffer.from(report.outcome_bytes, 'utf8');
    let landed;
    try {
      landed = land(project, {
      id: `obs-collab-${report.collab_id.slice(0, 16)}`,
      source: 'collab',
      bytes, sha: sha256(bytes), now,
      // the slug comes from an unauthenticated event: display only its safe characters
      title: `Collab outcome: ${String(JSON.parse(report.outcome_bytes).slug ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 100) || '(unnamed)'}`,
      receipt: { collab_id: report.collab_id, origin_anchor: report.origin_anchor, outcome_sha256: report.outcome_sha256, mapping: report.mapping },
      });
    } catch (e) {
      // one faulty item never suppresses the others or the log
      items.push({ collab: name, state: 'pending:land-error', detail: e.code || String(e.message).slice(0, 200) });
      continue;
    }
    items.push({ collab: name, state: landed.status, id: landed.id, late: report.late });
  }

  const day = now.slice(0, 10);
  const logDir = join(project, '_sessions', day);
  mkdirSync(logDir, { recursive: true });
  for (const it of items) appendFileSync(join(logDir, 'handoff-log.jsonl'), JSON.stringify({ ts: now, ...it }) + '\n');
  return { status: 'ok', items };
}

export function main(argv) {
  const [project, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i];
  if (!project) { process.stderr.write('usage: core-collab-sync.mjs <project> --participant <triplet> [--collab-cli <dir>] [--collab-root <dir>]\n'); return 2; }
  const r = syncCollab(project, { participant: opt.participant, ...(opt['collab-cli'] && { collabCli: opt['collab-cli'] }), ...(opt['collab-root'] && { collabRoot: opt['collab-root'] }) });
  process.stdout.write(JSON.stringify(r) + '\n');
  return r.items.some(i => i.state.startsWith('refused')) ? 1 : 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
