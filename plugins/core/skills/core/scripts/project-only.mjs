#!/usr/bin/env node
/**
 * project-only.mjs — CORE run from one project folder, with nothing outside it.
 *
 * The user selects it explicitly (`/core project-only`); nothing in a project folder can turn it
 * on. The skill passes `--root <canonical cwd>` and the operation runs from a context built from
 * those arguments alone: it never reads the account home, the registry, the install secret or
 * the install id, and it never enrolls the folder.
 *
 * State the mode writes lives in `<root>/.core/_project-only/<harness>/`, outside the signed
 * harness envelope (`.core/<harness>/` is never created or touched here) and under a name the
 * harness-folder pattern can't match, so installed-mode discovery never reads it as harness
 * state. Everything in it is unsigned and says so; installed mode treats it as pending data
 * that the user may merge, never as trusted or completed work.
 *
 * What the folder-only checks defend against: links that arrive with the folder, and links swapped
 * in between separate calls. They don't defend against a process running as the same user that
 * renames project folders during a call, between a check and the file operation it guards: Node has
 * no check-and-act that is atomic with a directory, and such a process already has the user's own
 * write access to the project and to wherever it would redirect CORE.
 *
 * The folder's existence is also a disable-only hint for the automatic hooks: where it is
 * present they exit before any registry lookup or log write. The hint can only switch
 * automation off; it grants nothing.
 *
 * CLI: node project-only.mjs startup --root <dir> [--harness <h>] [--session <id>]
 *      node project-only.mjs status|capture-status --root <dir> [--harness <h>]
 *      node project-only.mjs finalize-begin|finalize-certify|finalize-finish --root <dir> --session <id>
 *      node project-only.mjs finalize-record --root <dir> --session <id> --op <op> --status done|skipped|failed
 *      node project-only.mjs pickup|pickup-archive --root <dir> [--harness <h>]   (run from a normal session)
 *      node project-only.mjs purge --root <dir> [--apply]   (a dry run without --apply)
 *      node project-only.mjs process-memory --root <dir> [--apply]   (the script half only)
 *      node project-only.mjs retention --root <dir> [--apply]   (explicit only; never on a schedule)
 *      metrics, metrics-export, configure-project and
 *      memory-view answer `unavailable`; anything else is refused.
 * Prints one JSON line. Exits 2 on a refused root or bad arguments.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, parse, sep } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isCliEntry } from './cli-entry.mjs';
import { useNoMachineIdentity, acquireFileLock, releaseFileLock, inspectFileLock } from './file-lock.mjs';

export const PROJECT_ONLY_DIR = '_project-only';
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A name, not prose: letters, digits and light punctuation. Its source file is unverified and the value reaches the agent's context.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const ARCHIVE_DIR = '_archive';

/**
 * True when `cwd` holds an active project-only folder for any harness: a real directory under
 * `.core/_project-only/` with a harness name. Disable-only: it never grants anything. What a normal
 * session has picked up sits under `_archive/`, which is history and suppresses nothing.
 */
export function projectOnlyHint(cwd) {
  try {
    if (!cwd) return false;
    return readdirSync(join(String(cwd), '.core', PROJECT_ONLY_DIR), { withFileTypes: true })
      .some((e) => e.isDirectory() && HARNESS_RE.test(e.name));
  } catch { return false; }
}

/** The root for a project-only operation: an existing directory resolved physically, or a refusal. */
export function projectOnlyContext({ root, harness = 'claude-code', session = null, operation = 'startup' } = {}) {
  if (!root) return { ok: false, state: 'root-unresolved', reason: 'no --root given' };
  if (!HARNESS_RE.test(String(harness))) return { ok: false, state: 'bad-harness', reason: String(harness) };
  let real;
  try { real = realpathSync.native(String(root)); } catch (e) { return { ok: false, state: 'root-unresolved', reason: e.code || e.message }; }
  try { if (!statSync(real).isDirectory()) return { ok: false, state: 'root-unresolved', reason: 'not a directory' }; }
  catch (e) { return { ok: false, state: 'root-unresolved', reason: e.code || e.message }; }
  if (real === parse(real).root) return { ok: false, state: 'refused', reason: 'filesystem root' };
  let home = null;
  try { home = userInfo().homedir || null; } catch { /* no account record: the home check is skipped */ }
  if (home && real === home) return { ok: false, state: 'refused', reason: 'home folder' };
  return { ok: true, mode: 'project-only', root: real, harness, session, operation };
}

export const pendingDir = (ctx) => join(ctx.root, '.core', PROJECT_ONLY_DIR, ctx.harness);

// A folder can arrive with any of these paths as a link to somewhere else (a cloned repo, an
// unzipped archive), which would carry writes and reads out of the project. Every component CORE
// uses here must be a real directory or file under the root, never a link.
const outside = (what) => Object.assign(new Error(`project-only: ${what} is a link or leaves the folder`), { code: 'OUTSIDE_ROOT' });

/** A real (non-link) directory inside the root, created when absent; throws OUTSIDE_ROOT otherwise. */
function ownDir(ctx, path) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; mkdirSync(path); st = lstatSync(path); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw outside(path);
  const real = realpathSync.native(path);
  if (!real.startsWith(ctx.root + sep)) throw outside(path);
  return real;
}

/** A path inside the root that is not a link (absent is fine): the guard before every read. */
function ownFile(ctx, path) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (st.isSymbolicLink() || !st.isFile()) throw outside(path);
  return true;
}

/** Atomic write inside an own directory: an unguessable temp name created exclusively (never
 *  through a planted link), then renamed over the target (rename replaces a link, never follows it). */
function writeOwn(dir, name, body) {
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, body, { flag: 'wx' });
  try { renameSync(tmp, join(dir, name)); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Creates the pending folder, with `.core/.gitignore` in place before anything else is written. */
export function ensurePending(ctx) {
  // Every existing component is checked before anything is created, so a refusal changes nothing.
  for (const d of [join(ctx.root, '.core'), join(ctx.root, '.core', PROJECT_ONLY_DIR), pendingDir(ctx)]) {
    let st;
    try { st = lstatSync(d); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw outside(d);
  }
  const core = ownDir(ctx, join(ctx.root, '.core'));
  const ignore = join(core, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { flag: 'wx' });   // wx never follows a link or overwrites
  ownDir(ctx, join(core, PROJECT_ONLY_DIR));
  return ownDir(ctx, pendingDir(ctx));
}

function readJson(ctx, file) {
  try { if (!ownFile(ctx, file)) return { state: 'absent' }; } catch (e) { return { state: e.code === 'OUTSIDE_ROOT' ? 'refused-link' : 'unreadable', reason: e.code }; }
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', reason: e.code }; }
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? { state: 'ok', value: v } : { state: 'malformed' }; }
  catch { return { state: 'malformed' }; }
}

/**
 * What the project-only manifest says, unverified. Only restrictions take effect: a readable
 * `false` opt-out turns capture off; an unreadable or malformed manifest holds capture, which is
 * different from disabled. A `true` never widens anything.
 */
export function readPendingManifest(ctx) {
  let r;
  try {
    for (const d of [join(ctx.root, '.core'), join(ctx.root, '.core', PROJECT_ONLY_DIR), pendingDir(ctx)]) {
      const st = lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) throw outside(d);
    }
    r = readJson(ctx, join(pendingDir(ctx), 'manifest.json'));
  } catch (e) { r = e.code === 'ENOENT' ? { state: 'absent' } : { state: e.code === 'OUTSIDE_ROOT' ? 'refused-link' : 'unreadable' }; }
  if (r.state === 'absent') return { state: 'absent', agent_name: null, capture: 'default' };
  if (r.state !== 'ok') return { state: r.state, agent_name: null, capture: 'held' };
  const m = r.value;
  const name = typeof m.agent_name === 'string' && NAME_RE.test(m.agent_name) ? m.agent_name : null;
  const off = m.metrics_enabled === false || m.turn_capture === false;
  return { state: 'ok', agent_name: name, capture: off ? 'disabled' : 'default', verified: false };
}

export function startup(ctx, { now = new Date() } = {}) {
  let dir;
  try { dir = ensurePending(ctx); }
  catch (e) { if (e.code === 'OUTSIDE_ROOT') return { status: 'refused', state: 'refused-link', reason: e.message }; throw e; }
  const manifest = readPendingManifest(ctx);
  writeOwn(dir, 'bootstrap.json', JSON.stringify({ mode: 'project-only', harness: ctx.harness, session: ctx.session, at: now.toISOString() }, null, 2) + '\n');
  return {
    status: 'ok', mode: 'project-only', root: ctx.root, harness: ctx.harness,
    agent_name: manifest.agent_name, manifest: manifest.state, capture: manifest.capture,
    automatic: 'off',
    skipped: ['agent-profile', 'topics', 'native-recall', 'register', 'migration', 'drift-check', 'touch', 'capability-probe'],
  };
}

export function status(ctx) {
  const manifest = readPendingManifest(ctx);
  return { status: 'ok', mode: 'project-only', root: ctx.root, harness: ctx.harness, pending: existsSync(pendingDir(ctx)), manifest: manifest.state, capture: manifest.capture };
}

/**
 * Captured-turn status from the project's own `_metrics/` only. History an earlier version kept
 * outside the folder can't be looked at in this mode, so it is reported as unknown, never none.
 */
export function captureStatus(ctx) {
  const dir = join(ctx.root, '_metrics', 'turn-capture');
  const files = [];
  let rows = 0;
  let state = 'ok';
  try {
    for (const d of [join(ctx.root, '_metrics'), dir]) { const st = lstatSync(d); if (st.isSymbolicLink() || !st.isDirectory()) throw outside(d); }
    for (const f of readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
      if (!ownFile(ctx, join(dir, f))) continue;
      files.push(f);
      rows += readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).length;
    }
  } catch (e) {
    if (e.code === 'ENOENT') state = 'none-in-project';
    else return { status: 'ok', mode: 'project-only', in_project: { state: e.code === 'OUTSIDE_ROOT' ? 'refused-link' : 'unreadable', reason: e.code }, outside_history: 'unknown' };
  }
  return { status: 'ok', mode: 'project-only', in_project: { state, files: files.length, rows, first: files[0] || null, last: files.at(-1) || null }, outside_history: 'unknown', capture: readPendingManifest(ctx).capture };
}

const NORMAL = 'is not available in project-only mode; it reads or writes outside the folder. Run it in a normal session';
const UNAVAILABLE = {
  metrics: `the metrics report ${NORMAL}`,
  'configure-project': `project configuration ${NORMAL}`,
  'memory-view': `the memory view ${NORMAL}`,
  'metrics-export': `the metrics export ${NORMAL}`,
};

// ---------- purge ----------
//
// The explicit captured-turn purge, from the folder alone. It removes what this project holds:
// the captured turns, the capture health file and the judgment log under `_metrics/`. It never
// looks outside the folder, so copies an installed session or an earlier version kept elsewhere are
// reported as unknown and the outcome is `purged-in-project`, never a bare "purged". A dry run
// unless `apply` is set. A target that is a link is left alone and named.
const PURGE_TARGETS = [['turn-capture', 'dir'], ['turn-capture-health.json', 'file'], ['judgment-log.jsonl', 'file']];

export function purge(ctx, { apply = false } = {}) {
  const metrics = join(ctx.root, '_metrics');
  const base = { status: 'ok', mode: 'project-only', operation: 'purge', applied: false, outside_history: 'unknown' };
  let st;
  try { st = lstatSync(metrics); } catch (e) {
    if (e.code === 'ENOENT') return { ...base, outcome: 'nothing-in-project', removed: [], would_remove: [], refused: [] };
    return { status: 'refused', state: 'unreadable', reason: e.code };
  }
  if (st.isSymbolicLink() || !st.isDirectory() || !realpathSync.native(metrics).startsWith(ctx.root + sep)) return { status: 'refused', state: 'refused-link', reason: outside(metrics).message };
  const present = []; const refused = [];
  for (const [name, kind] of PURGE_TARGETS) {
    let t;
    try { t = lstatSync(join(metrics, name)); } catch (e) { if (e.code === 'ENOENT') continue; refused.push({ path: `_metrics/${name}`, reason: e.code }); continue; }
    if (t.isSymbolicLink() || (kind === 'dir' ? !t.isDirectory() : !t.isFile())) { refused.push({ path: `_metrics/${name}`, reason: 'link-or-wrong-type' }); continue; }
    present.push(name);
  }
  const rel = present.map((n) => `_metrics/${n}`);
  if (!apply) return { ...base, outcome: 'dry-run', would_remove: rel, removed: [], refused };
  const lockPath = join(metrics, '.turn-capture.lock');
  for (const name of readdirSync(metrics)) {
    if (!name.startsWith('.turn-capture.lock')) continue;
    const g = lstatSync(join(metrics, name));
    if (g.isSymbolicLink() || !g.isFile()) return { status: 'refused', state: 'refused-link', reason: outside(join(metrics, name)).message };
  }
  const lock = acquireFileLock(lockPath, { extra: { mode: 'project-only', op: 'purge' }, machine: null });
  if (!lock.ok) return { status: 'refused', state: 'lock-held', reason: lock.reason };
  const removed = [];
  try {
    for (const name of present) {
      const target = join(metrics, name);
      const again = lstatSync(target);   // checked again under the lock, just before the removal
      if (again.isSymbolicLink()) { refused.push({ path: `_metrics/${name}`, reason: 'link-or-wrong-type' }); continue; }
      rmSync(target, { recursive: true, force: true });   // removes a link found inside, never follows it
      if (existsSync(target)) refused.push({ path: `_metrics/${name}`, reason: 'still-present' }); else removed.push(`_metrics/${name}`);
    }
  } finally { releaseFileLock(lockPath, lock.nonce); }
  return { ...base, applied: true, outcome: refused.length ? 'partly-purged-in-project' : removed.length ? 'purged-in-project' : 'nothing-in-project', removed, would_remove: [], refused };
}

/**
 * Explicit retention: removes this folder's captured-turn files older than the window. Never runs
 * on a schedule. A dry run unless `apply` is set; the capture folder chain must be real directories.
 */
export async function retention(ctx, { apply = false } = {}) {
  const metrics = join(ctx.root, '_metrics');
  const base = { status: 'ok', mode: 'project-only', operation: 'retention', applied: false, outside_history: 'unknown' };
  try {
    for (const d of [metrics, join(metrics, 'turn-capture')]) {
      const st = lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory() || !realpathSync.native(d).startsWith(ctx.root + sep)) return { status: 'refused', state: 'refused-link', reason: outside(d).message };
    }
    for (const name of readdirSync(metrics)) {
      if (name.startsWith('.turn-capture.lock') && lstatSync(join(metrics, name)).isSymbolicLink()) return { status: 'refused', state: 'refused-link', reason: outside(join(metrics, name)).message };
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { ...base, outcome: 'nothing-in-project', window_days: null, candidates: [], removed: [] };
    return { status: 'refused', state: 'unreadable', reason: e.code };
  }
  const { runTurnCaptureRetention } = await import('./turn-capture.mjs');
  const r = runTurnCaptureRetention(ctx.root, { apply });
  const rel = (f) => `_metrics/turn-capture/${String(f).split(/[\\/]/).pop()}`;
  if (apply && !r.verified) return { status: 'refused', state: 'retention-incomplete', removed: r.deleted.map(rel), reason: 'some files could not be removed' };
  return { ...base, applied: apply, outcome: apply ? (r.deleted.length ? 'removed-in-project' : 'nothing-past-window') : 'dry-run', window_days: r.windowDays, cutoff: r.cutoff, candidates: r.candidates.map(rel), removed: r.deleted.map(rel) };
}

// ---------- memory processing, the script half ----------
//
// What `/process-memory` does by script, from the folder alone: check the units, refresh the link
// blocks, regenerate the indexes, check the PROJECT.md cap. The reasoning half (reading the session
// for missed observations, graduating them) is the agent's work under the protocol and is not run
// or proven here. Steps that read outside the folder are named in `not_run`, never skipped silently.
const PM_NOT_RUN = [
  'backfill from session transcripts (they are outside the folder)',
  'native-memory boundary audit and index (the harness memory is outside the folder)',
  'derived metrics: hindsight judge, scorecard, self-test regrade, rollup (their gate reads the registry and signed manifest)',
  'capability drift (its history is installed state)',
  'graduation and look-back (agent reasoning under the protocol, not a script)',
];

/** The first link found anywhere under `dir` (never followed), or null. An unlistable folder throws. */
function firstLinkUnder(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) return p;
    if (e.isDirectory()) { const inner = firstLinkUnder(p); if (inner) return inner; }
  }
  return null;
}

export async function processMemory(ctx, { apply = false } = {}) {
  const { storeBoundaryProblem } = await import('./generate-summary-index.mjs');
  const problem = storeBoundaryProblem(ctx.root);
  if (problem) return { status: 'refused', state: problem.code === 'STORE_OUTSIDE_ROOT' ? 'refused-link' : 'boundary-unverified', reason: problem.path };
  const mem = join(ctx.root, '_memories');
  try { const st = lstatSync(mem); if (!st.isDirectory()) throw Object.assign(new Error('no store'), { code: 'ENOENT' }); }
  catch (e) { return e.code === 'ENOENT' ? { status: 'refused', state: 'no-store', reason: 'no _memories/ in this folder' } : { status: 'refused', state: 'unreadable', reason: e.code }; }
  // The steps below read every unit and rewrite lock, index and cache files, and not all of their
  // readers skip links. So nothing anywhere under `_memories` may be a link, and neither may the
  // synthesis files beside it: a link is refused and named before any step runs.
  let link;
  try { link = firstLinkUnder(mem); } catch (e) { return { status: 'refused', state: 'boundary-unverified', reason: `${e.code || e.message}: part of _memories could not be listed` }; }
  if (link) return { status: 'refused', state: 'refused-link', reason: outside(link).message };
  for (const name of ['PROJECT.md', 'PROJECT-ARCHIVE.md']) {
    let g; try { g = lstatSync(join(ctx.root, name)); } catch { continue; }
    if (g.isSymbolicLink()) return { status: 'refused', state: 'refused-link', reason: outside(join(ctx.root, name)).message };
  }
  const { iterActiveUnits, checkSchema, checkIntegrity } = await import('./check-units.mjs');
  const { decorateStoreLocked } = await import('./decorate-graph.mjs');
  const { runMaintenance } = await import('./maintenance-run.mjs');
  const report = [];
  const units = iterActiveUnits(mem, { includeObservations: false });
  if (units.length) { checkSchema(units, mem, report); checkIntegrity(units, mem, new Date(), report); }
  const count = (sev) => report.filter((r) => String(r.severity || r.level || '').toUpperCase() === sev).length;
  const decoration = decorateStoreLocked(ctx.root, { dryRun: !apply });
  const upkeep = runMaintenance(ctx.root, { apply, metrics: false });
  return {
    status: 'ok', mode: 'project-only', operation: 'process-memory', applied: apply,
    units_checked: units.length, unit_findings: { fail: count('FAIL'), warn: count('WARN') },
    decoration: { changed: (decoration.changed || []).length, refused: decoration.refused || [], needs_reconciliation: decoration.needs_reconciliation || [] },
    upkeep: { ran: upkeep.ranOps || [], notes: upkeep.notes || [] },
    not_run: PM_NOT_RUN,
  };
}

// ---------- /finalize project-only ----------
//
// The same close ops as a normal close, under the same project close lock (one mutex per project
// whichever mode takes it). The native memory refresh writes the harness's own memory outside the
// folder, so here it is always `unavailable`, and certification is `partial`, never `closed`. All
// close evidence stays in the pending folder: the normal close's readers (`_metrics/close/receipts`,
// `_memories/_close-marker.json`) never see it, so it can't suppress a normal close.
const CLOSE_OPS = ['material-capture', 'render-project-md', 'session-summary', 'memory-refresh'];
const OP_STATUS = new Set(['done', 'skipped', 'failed']);
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const closeLock = (ctx) => join(ctx.root, '_memories', '_close.lock');
const closeDir = (ctx) => join(pendingDir(ctx), 'close');

/** Every directory from `.core` down to the close folder is a real, non-link directory, checked
 *  again on each call: a separate CLI call can't trust what an earlier one saw. */
function closeChain(ctx, extra = []) {
  for (const d of [join(ctx.root, '.core'), join(ctx.root, '.core', PROJECT_ONLY_DIR), pendingDir(ctx), closeDir(ctx), ...extra]) {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw outside(d);
  }
}

/** The project close lock's folder and every generation file in it: a real `_memories` directory
 *  inside the root, and regular files, never links, checked on each call before the lock is read,
 *  taken or released. A link anywhere here would carry lock I/O out of the project. */
function lockChain(ctx) {
  const mem = join(ctx.root, '_memories');
  const st = lstatSync(mem);
  if (st.isSymbolicLink() || !st.isDirectory() || !realpathSync.native(mem).startsWith(ctx.root + sep)) throw outside(mem);
  for (const name of readdirSync(mem)) {
    if (!name.startsWith('_close.lock') && !name.startsWith('._close.lock')) continue;
    const g = lstatSync(join(mem, name));
    if (g.isSymbolicLink() || !g.isFile()) throw outside(join(mem, name));
  }
}

function readMarker(ctx) {
  try { closeChain(ctx); } catch (e) { return { refused: e.code === 'OUTSIDE_ROOT' ? 'refused-link' : 'no-close-begun' }; }
  const r = readJson(ctx, join(closeDir(ctx), 'marker.json'));
  return r.state === 'ok' ? r.value : { refused: r.state === 'refused-link' ? 'refused-link' : 'no-close-begun' };
}

// The marker is evidence only while its begin still owns the project close lock: the current lock
// generation must carry the nonce and session the begin recorded. After begin's process exits the
// lock stays held until it ages past the stale window (the normal close's rule); once a newer owner
// takes it, this marker can no longer record, certify or release.
function markerFor(ctx) {
  const m = readMarker(ctx);
  if (m.refused) return { refused: { status: 'refused', state: m.refused } };
  if (m.session_id !== ctx.session) return { refused: { status: 'refused', state: 'marker-session-mismatch', session_id: ctx.session } };
  try { lockChain(ctx); } catch (e) { return { refused: { status: 'refused', state: e.code === 'OUTSIDE_ROOT' ? 'refused-link' : 'lock-unreadable', reason: e.message } }; }
  const held = inspectFileLock(closeLock(ctx), { machine: null });
  if (!held.held || !held.lock || held.lock.nonce !== m.lock_nonce || held.lock.session_id !== ctx.session) {
    return { refused: { status: 'refused', state: 'lock-not-owned', reason: 'this close no longer holds the project close lock; begin again' } };
  }
  return { marker: m };
}

function needSession(ctx) {
  if (!ctx.session || !SESSION_RE.test(ctx.session)) return { status: 'refused', state: 'session-required', reason: 'project-only /finalize needs an explicit --session id (transcripts are outside the folder)' };
  return null;
}

export function finalizeBegin(ctx, { now = new Date() } = {}) {
  const bad = needSession(ctx); if (bad) return bad;
  let dir;
  try { ensurePending(ctx); dir = ownDir(ctx, closeDir(ctx)); ownDir(ctx, join(ctx.root, '_memories')); lockChain(ctx); }
  catch (e) { if (e.code === 'OUTSIDE_ROOT') return { status: 'refused', state: 'refused-link', reason: e.message }; throw e; }
  const lock = acquireFileLock(closeLock(ctx), { extra: { session_id: ctx.session, mode: 'project-only' }, machine: null });
  if (!lock.ok) return { status: 'refused', state: 'lock-held', reason: lock.reason };
  writeOwn(dir, 'marker.json', JSON.stringify({ mode: 'project-only', session_id: ctx.session, harness: ctx.harness, begun_at: now.toISOString(), lock_nonce: lock.nonce, ops: { 'memory-refresh': { status: 'unavailable', reason: 'native memory is outside the project folder' } } }, null, 2) + '\n');
  return { status: 'ok', mode: 'project-only', session_id: ctx.session, ops: CLOSE_OPS };
}

export function finalizeRecord(ctx, { op, opStatus, now = new Date() } = {}) {
  const bad = needSession(ctx); if (bad) return bad;
  const { marker: m, refused } = markerFor(ctx); if (refused) return refused;
  if (!CLOSE_OPS.includes(op) || op === 'memory-refresh') return { status: 'refused', state: 'bad-op', reason: op === 'memory-refresh' ? 'memory-refresh is unavailable in project-only mode' : `unknown op ${op}` };
  if (!OP_STATUS.has(opStatus)) return { status: 'refused', state: 'bad-status', reason: String(opStatus) };
  m.ops[op] = { status: opStatus, at: now.toISOString() };
  writeOwn(closeDir(ctx), 'marker.json', JSON.stringify(m, null, 2) + '\n');
  return { status: 'ok', op, op_status: opStatus };
}

export function finalizeCertify(ctx, { now = new Date() } = {}) {
  const bad = needSession(ctx); if (bad) return bad;
  const { marker: m, refused } = markerFor(ctx); if (refused) return refused;
  const satisfied = (op) => m.ops[op] && (m.ops[op].status === 'done' || (op === 'render-project-md' && m.ops[op].status === 'skipped'));
  const incomplete = CLOSE_OPS.filter((op) => op !== 'memory-refresh' && !satisfied(op));
  if (incomplete.length) return { status: 'refused', state: 'required-ops-incomplete', incomplete };
  let dir;
  try { dir = ownDir(ctx, join(closeDir(ctx), 'receipts')); closeChain(ctx, [dir]); }
  catch (e) { if (e.code === 'OUTSIDE_ROOT') return { status: 'refused', state: 'refused-link', reason: e.message }; throw e; }
  const receipt = { mode: 'project-only', session_id: ctx.session, harness: ctx.harness, root: ctx.root, outcome: 'partial', unavailable: ['memory-refresh'], certified_at: now.toISOString() };
  writeOwn(dir, `${ctx.session}.json`, JSON.stringify(receipt, null, 2) + '\n');
  return { status: 'ok', outcome: 'partial', unavailable: ['memory-refresh'], session_id: ctx.session };
}

export function finalizeFinish(ctx) {
  const bad = needSession(ctx); if (bad) return bad;
  const { marker: m, refused } = markerFor(ctx); if (refused) return refused;
  const r = releaseFileLock(closeLock(ctx), m.lock_nonce);
  return r.released ? { status: 'ok', released: true } : { status: 'refused', state: 'release-failed', reason: r.reason };
}

// ---------- pickup in a normal session ----------
//
// A normal session reads what project-only sessions left in the pending folder as data, never as
// authority: the report names what is there, nothing in it is adopted as a completed close, and it
// never registers the folder or touches the signed envelope. The agent merges the typed fields it
// wants (an agent name when the signed manifest has none; a capture opt-out, which only restricts)
// through the normal manifest writer, then archives the folder. Archiving renames into
// `_archive/`, never deletes, and ends this harness's hook suppression; another harness's pending
// folder keeps its own.
function pendingChain(ctx) {
  for (const d of [join(ctx.root, '.core'), join(ctx.root, '.core', PROJECT_ONLY_DIR), pendingDir(ctx)]) {
    const st = lstatSync(d);   // ENOENT propagates: nothing pending
    if (st.isSymbolicLink() || !st.isDirectory()) throw outside(d);
  }
}

export function pickup(ctx) {
  try { pendingChain(ctx); }
  catch (e) {
    if (e.code === 'ENOENT') return { status: 'ok', mode: 'pickup', pending: false };
    if (e.code === 'OUTSIDE_ROOT') return { status: 'refused', state: 'refused-link', reason: e.message };
    return { status: 'refused', state: 'unreadable', reason: e.code || e.message };
  }
  const manifest = readPendingManifest(ctx);
  const boot = readJson(ctx, join(pendingDir(ctx), 'bootstrap.json'));
  const marker = readMarker(ctx);
  const receipts = [];
  const rdir = join(closeDir(ctx), 'receipts');
  let receiptsState = 'ok';
  try {
    closeChain(ctx, [rdir]);
    for (const f of readdirSync(rdir).filter((n) => n.endsWith('.json')).sort()) {
      const r = readJson(ctx, join(rdir, f));
      if (r.state === 'ok' && typeof r.value.session_id === 'string' && SESSION_RE.test(r.value.session_id)) receipts.push({ session_id: r.value.session_id, outcome: r.value.outcome === 'partial' ? 'partial' : 'unrecognized', certified_at: typeof r.value.certified_at === 'string' && ISO_RE.test(r.value.certified_at) ? r.value.certified_at : null });
    }
  } catch (e) { if (e.code !== 'ENOENT') receiptsState = e.code === 'OUTSIDE_ROOT' ? 'refused-link' : 'unreadable'; }
  const certified = new Set(receipts.map((r) => r.session_id));
  const unfinished = typeof marker.session_id === 'string' && SESSION_RE.test(marker.session_id) && !certified.has(marker.session_id) ? marker.session_id : null;
  return {
    status: 'ok', mode: 'pickup', pending: true, root: ctx.root, harness: ctx.harness,
    unverified: true,
    agent_name: manifest.agent_name, manifest: manifest.state, capture: manifest.capture,
    last_session: boot.state === 'ok' && typeof boot.value.session === 'string' && SESSION_RE.test(boot.value.session) ? boot.value.session : null,
    partial_closes: receipts, receipts: receiptsState, unfinished_close: unfinished,
    // Every project-only close was partial: a normal close is still owed for the native refresh.
    adopted: { completion: false, enrollment: false },
    owed_in_normal_session: ['memory-refresh'],
  };
}

/** Moves the pending folder aside once its data has been merged (or the user declines to). */
export function pickupArchive(ctx, { now = new Date() } = {}) {
  const r = pickup(ctx);
  if (r.status !== 'ok' || !r.pending) return r;
  if (r.unfinished_close) return { status: 'refused', state: 'close-in-progress', session_id: r.unfinished_close, reason: 'a project-only close has begun and not certified; finish or release it first' };
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let archive;
  try { archive = ownDir(ctx, join(ctx.root, '.core', PROJECT_ONLY_DIR, ARCHIVE_DIR)); }
  catch (e) { if (e.code === 'OUTSIDE_ROOT') return { status: 'refused', state: 'refused-link', reason: e.message }; throw e; }
  const dest = join(archive, `${ctx.harness}-${stamp}`);
  if (existsSync(dest)) return { status: 'refused', state: 'destination-exists', reason: dest };
  writeOwn(pendingDir(ctx), 'picked-up.json', JSON.stringify({ picked_up_at: now.toISOString(), merged: 'by the normal session; nothing here was adopted as completed work' }, null, 2) + '\n');
  renameSync(pendingDir(ctx), dest);
  return { status: 'ok', mode: 'pickup', archived: true, to: dest };
}

export function main(argv) {
  useNoMachineIdentity();   // no lock in this process reads ~/.core/install-id
  const [cmd, ...rest] = argv;
  const opt = {};
  const FLAGS = new Set(['apply']);
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); opt[k] = FLAGS.has(k) ? true : rest[++i]; }
  const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); return o.status === 'ok' ? 0 : 2; };
  if (UNAVAILABLE[cmd]) return out({ status: 'unavailable', state: 'unavailable', operation: cmd, reason: UNAVAILABLE[cmd] });
  const run = {
    startup, status, 'capture-status': captureStatus, pickup, 'pickup-archive': pickupArchive,
    purge: (ctx) => purge(ctx, { apply: opt.apply === true }),
    'process-memory': (ctx) => processMemory(ctx, { apply: opt.apply === true }),
    retention: (ctx) => retention(ctx, { apply: opt.apply === true }),
    'finalize-begin': finalizeBegin, 'finalize-certify': finalizeCertify, 'finalize-finish': finalizeFinish,
    'finalize-record': (ctx) => finalizeRecord(ctx, { op: opt.op, opStatus: opt.status }),
  }[cmd];
  if (!run) return out({ status: 'refused', state: 'unknown-command', reason: `project-only supports startup, status, capture-status, purge, retention, process-memory, pickup, pickup-archive and finalize-begin|record|certify|finish, not ${cmd || '(none)'}` });
  const ctx = projectOnlyContext({ root: opt.root, harness: opt.harness || 'claude-code', session: opt.session || null, operation: cmd });
  if (!ctx.ok) return out({ status: 'refused', ...ctx });
  const result = run(ctx);
  return result instanceof Promise ? result.then(out) : out(result);
}

if (isCliEntry(import.meta.url)) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
