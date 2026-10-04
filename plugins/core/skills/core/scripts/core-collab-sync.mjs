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
 * The participant is this project's persisted collab identity, looked up read-only by the
 * project's opaque project_id (collab-identity.mjs --show); with none, sync is a named no-op.
 *
 * CLI: node core-collab-sync.mjs <project> [--participant <id>] [--collab-cli <dir>]
 *        [--collab-root <dir>] [--readiness]
 *   --collab-cli defaults to the Claude Code install record (never an environment variable);
 *   --collab-root to $COLLAB_LOCAL_ROOT or ~/.collab/local. --readiness prints at most three
 *   plain lines (nothing when all is well) and never exits non-zero.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './cli-entry.mjs';
import { landObservation, sha256 } from './land-observation.mjs';

const SPAWN_TIMEOUT_MS = 20000;

/**
 * collab's scripts dir, from the Claude Code install record only. This picks code that the
 * automatic hook will run, so nothing a project or a hostile environment controls may choose it:
 * no environment variable, the home folder comes from the OS account database (not $HOME), and
 * the resolved directory must sit inside that account's ~/.claude/plugins/. Null when absent.
 * A manual run can still name a scripts dir explicitly with --collab-cli.
 */
export function findCollabScripts(_env = process.env, home = userInfo().homedir) {
  try {
    const rec = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const plugins = rec.plugins || rec;
    const key = Object.keys(plugins).find(k => k.startsWith('collab@'));
    const entry = key && (Array.isArray(plugins[key]) ? plugins[key][0] : plugins[key]);
    const dir = entry?.installPath && join(entry.installPath, 'skills', 'collab', 'scripts');
    if (!dir || !existsSync(dir)) return null;
    const real = realpathSync(dir), base = realpathSync(join(home, '.claude', 'plugins'));
    const rel = relative(base, real);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? real : null;
  } catch { return null; }
}

/**
 * This project's collab participant: the persisted identity collab holds for the project's
 * opaque project_id, read through collab's read-only `--show`. Never minted, never guessed.
 */
export function lookupParticipant(project, collabCli, projectId = null) {
  const registry = join(dirname(fileURLToPath(import.meta.url)), 'index-registry.mjs');
  if (!projectId) {
    const m = spawnSync(process.execPath, [registry, 'manifest', '--root', project], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    try { projectId = JSON.parse(m.stdout).project_id || null; } catch { /* below */ }
  }
  if (!projectId) return { error: 'no project_id in this project\'s manifest' };
  const idCli = join(collabCli, 'collab-identity.mjs');
  if (!existsSync(idCli)) return { error: 'this collab version has no read-only identity lookup' };
  const r = spawnSync(process.execPath, [idCli, '--show', projectId], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  if (r.status === 3) return { error: 'no collab identity for this project' };
  if (r.status !== 0) return { error: `collab identity unreadable (${(r.stderr || '').trim().slice(0, 120) || `exit ${r.status}`})` };
  try { const id = JSON.parse(r.stdout); return { participants: [id.participant_id, id.triplet].filter(Boolean), projectId }; }
  catch { return { error: 'collab identity output unparseable' }; }
}

/** At most three readiness lines; nothing when every item is landed, already-landed or open. */
export function readinessLines(result) {
  if (result.status === 'skipped') return result.reason?.startsWith('collab is not installed') ? [] : [`Collab handoff: skipped — ${result.reason}.`];
  if (result.status === 'error') return [`Collab handoff: the sync did not finish (${result.reason}); nothing was lost, it retries next run.`];
  const quiet = new Set(['landed', 'already-landed', 'open']);
  const loud = result.items.filter(i => !quiet.has(i.state));
  if (!loud.length) return [];
  const counts = {};
  for (const i of result.items) counts[i.state.split(':')[0]] = (counts[i.state.split(':')[0]] || 0) + 1;
  const named = loud.slice(0, 5).map(i => `${i.collab} (${i.state})`).join(', ');
  return [
    `Collab handoff: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
    `Needs a look: ${named}${loud.length > 5 ? `, +${loud.length - 5} more` : ''} — full list in _sessions/<date>/handoff-log.jsonl.`,
  ];
}

export function syncCollab(project, { land = landObservation, projectId = null, participant, collabCli = undefined, collabRoot = process.env.COLLAB_LOCAL_ROOT || join(homedir(), '.collab', 'local'), now = new Date().toISOString() } = {}) {
  collabCli ??= findCollabScripts();
  const outcomeCli = collabCli ? join(collabCli, 'collab-outcome.mjs') : null;
  if (!outcomeCli || !existsSync(outcomeCli)) return { status: 'skipped', reason: 'collab is not installed (no collab-outcome.mjs found)', items: [] };
  if (!participant) {
    const id = lookupParticipant(project, collabCli, projectId);
    if (id.error) return { status: 'skipped', reason: id.error, items: [] };
    participant = id.participants;
  }
  if (!existsSync(collabRoot)) return { status: 'ok', items: [] };

  const items = [];
  for (const name of readdirSync(collabRoot).sort()) {
    const dir = join(collabRoot, name);
    const r = spawnSync(process.execPath, [outcomeCli, dir, ...[].concat(participant).flatMap(p => ['--participant', p])], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: SPAWN_TIMEOUT_MS });
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
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  if (!project) { process.stderr.write('usage: core-collab-sync.mjs <project> [--participant <id>] [--collab-cli <dir>] [--collab-root <dir>] [--readiness]\n'); return 2; }
  let r;
  try {
    r = syncCollab(project, { participant: opt.participant, ...(opt['collab-cli'] && { collabCli: opt['collab-cli'] }), ...(opt['collab-root'] && { collabRoot: opt['collab-root'] }) });
  } catch (e) {
    // the readiness path never fails startup: an unexpected error is one plain line
    if (!opt.readiness) throw e;
    r = { status: 'error', reason: e.code || String(e.message).slice(0, 120), items: [] };
  }
  if (opt.readiness) { for (const l of readinessLines(r)) process.stdout.write(l + '\n'); return 0; }
  process.stdout.write(JSON.stringify(r) + '\n');
  return r.items.some(i => i.state.startsWith('refused')) ? 1 : 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
