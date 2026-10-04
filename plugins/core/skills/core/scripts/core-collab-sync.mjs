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
import { detectStateHarness } from './project-state.mjs';

const SPAWN_TIMEOUT_MS = 20000;
export const TOTAL_BUDGET_MS = 45000;   // the whole run, under the hook's 60 s timeout

/**
 * collab's scripts dir, from the Claude Code install record only. This picks code that the
 * automatic hook will run, so nothing a project or a hostile environment controls may choose it:
 * no environment variable, the home folder comes from the OS account database (not $HOME), and
 * the resolved directory must sit inside that account's ~/.claude/plugins/. Null when absent.
 * A manual run can still name a scripts dir explicitly with --collab-cli.
 */
export function findCollabScripts(env = process.env, home = userInfo().homedir, harness = detectStateHarness(env)) {
  const contained = (dir, base) => {
    try {
      if (!dir || !existsSync(dir)) return null;
      const real = realpathSync(dir), rel = relative(realpathSync(base), real);
      return rel && !rel.startsWith('..') && !isAbsolute(rel) ? real : null;
    } catch { return null; }
  };
  if (harness === 'codex') {
    // Codex plugin cache: ~/.codex/plugins/cache/<marketplace>/collab/<version>/ — newest version wins.
    const base = join(home, '.codex', 'plugins');
    const found = [];
    try {
      for (const m of readdirSync(join(base, 'cache'))) {
        const vdir = join(base, 'cache', m, 'collab');
        if (!existsSync(vdir)) continue;
        for (const v of readdirSync(vdir)) found.push({ v, dir: join(vdir, v, 'skills', 'collab', 'scripts') });
      }
    } catch { return null; }
    const cmp = (a, b) => { const x = a.v.split(/[.-]/).map(Number), y = b.v.split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
    for (const f of found.sort(cmp).reverse()) { const ok = contained(f.dir, base); if (ok) return ok; }
    return null;
  }
  try {
    const rec = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const plugins = rec.plugins || rec;
    const key = Object.keys(plugins).find(k => k.startsWith('collab@'));
    const entry = key && (Array.isArray(plugins[key]) ? plugins[key][0] : plugins[key]);
    return contained(entry?.installPath && join(entry.installPath, 'skills', 'collab', 'scripts'), join(home, '.claude', 'plugins'));
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
  // fixed wording only: collab's stderr echoes record contents another process can write
  if (r.status === 5) return { error: 'collab identity belongs to another workspace' };
  if (r.status !== 0) return { error: `collab identity unreadable (exit ${Number(r.status) || 'signal'})` };
  try { const id = JSON.parse(r.stdout); return { participants: [id.participant_id, id.triplet].filter(Boolean), projectId }; }
  catch { return { error: 'collab identity output unparseable' }; }
}

// Readiness lines reach the model's context, and collab names and states come from directories
// and files other processes can write. Only these shapes pass; anything else is replaced.
const safeName = (n) => String(n).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || '(unnamed)';
const SAFE_STATE = /^(landed|already-landed|open|not-joined|(pending|refused):[a-z-]+(:[a-z-]+)?( [A-Za-z0-9._,-]{1,120})?)$/;
const safeState = (st) => (SAFE_STATE.test(String(st)) ? String(st) : 'refused:unrecognized-state');
const SAFE_REASON = /^[A-Za-z0-9 ()._,:'-]{1,160}$/;
const safeReason = (r) => (SAFE_REASON.test(String(r)) ? String(r) : 'unrecognized reason');

/** At most three readiness lines; nothing when every item is landed, already-landed or open. */
export function readinessLines(result) {
  if (result.status === 'skipped') return result.reason?.startsWith('collab is not installed') ? [] : [`Collab handoff: skipped — ${safeReason(result.reason)}.`];
  if (result.status === 'error') return [`Collab handoff: the sync did not finish (${safeReason(result.reason)}); nothing was lost, it retries next run.`];
  const quiet = new Set(['landed', 'already-landed', 'open']);
  const loud = result.items.filter(i => !quiet.has(i.state));
  if (!loud.length) return [];
  const counts = {};
  for (const i of result.items) { const k = safeState(i.state).split(':')[0]; counts[k] = (counts[k] || 0) + 1; }
  const named = loud.slice(0, 5).map(i => `${safeName(i.collab)} (${safeState(i.state)})`).join(', ');
  return [
    `Collab handoff: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
    `Needs a look: ${named}${loud.length > 5 ? `, +${loud.length - 5} more` : ''} — full list in _sessions/<date>/handoff-log.jsonl.`,
  ];
}

export { writeNotice, takeNotice } from './collab-notice.mjs';

export function syncCollab(project, { land = landObservation, projectId = null, budgetMs = TOTAL_BUDGET_MS, clock = Date.now, participant, collabCli = undefined, collabRoot = process.env.COLLAB_LOCAL_ROOT || join(homedir(), '.collab', 'local'), now = new Date().toISOString() } = {}) {
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
  const deadline = clock() + budgetMs;
  for (const name of readdirSync(collabRoot).sort()) {
    const dir = join(collabRoot, name);
    const left = deadline - clock();
    // the run as a whole is bounded: what the budget can't reach is named, and the next run continues
    if (left <= 0) { items.push({ collab: name, state: 'pending:budget-exhausted' }); continue; }
    const r = spawnSync(process.execPath, [outcomeCli, dir, ...[].concat(participant).flatMap(p => ['--participant', p])], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: Math.min(SPAWN_TIMEOUT_MS, left) });
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
