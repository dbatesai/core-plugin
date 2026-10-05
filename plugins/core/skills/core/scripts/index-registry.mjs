/**
 * index-registry.mjs — the ONLY sanctioned writer of ~/.core/projects.json.
 *
 * projects.json is the list of project roots the user registered by running
 * /core there: `[{ "path": "<root>", "registered_at": "<iso>" }]`. It is the
 * trust anchor for auto-close — a repo cannot plant an entry — so every
 * mutation routes through this script, which does the full read-decide-write
 * under the nonce-CAS lock from file-lock.mjs. Protocol prose calls this CLI;
 * protocols/data-storage.md forbids hand-editing it.
 *
 * Per-project records (last-active, the bootstrap record) are single-owner files
 * in the project's own state, `<root>/_core/<harness>/`, written through
 * project-state.mjs. They need no registry lock.
 *
 * The legacy ~/.core/index.json is read-only here apart from mutateIndex, which the
 * migration uses to mark entries migrated.
 *
 * Lock order (documented total order): callers holding a per-project lock (e.g.
 * close-pass's _close.lock) take THIS lock inside it, never the reverse.
 *
 * CLI (root defaults to the registered project containing the working directory):
 *   node index-registry.mjs register [<dir>] [--confirm-new]          [--core-dir <dir>]
 *        prints action adopt-ask (exit 5) instead of registering when the folder carries
 *        another install's CORE state the user hasn't declined; ask, then run adopt
 *   node index-registry.mjs adopt-status [--root <dir>]               [--core-dir <dir>]
 *   node index-registry.mjs adopt --yes|--no [--root <dir>]           [--core-dir <dir>]
 *        interactive /core startup only, after the user answers the adoption question
 *   node index-registry.mjs list                                      [--core-dir <dir>]
 *   node index-registry.mjs touch [--root <dir>] [--when <ISO>]       [--core-dir <dir>]
 *        also prints one line per state event: state-created, state-unverified (set aside
 *        unread), state-copied, state-moved (registry updated), state-foreign (another
 *        install's state; no new local fallback payload), state-ask
 *   node index-registry.mjs state --accept-move|--fresh [--root <dir>] [--core-dir <dir>]
 *   node index-registry.mjs manifest [--root <dir>] [--set-json '<json>'] [--core-dir <dir>]
 *   node index-registry.mjs path --kind durable|hot [--name <file>] [--root <dir>] [--core-dir <dir>]
 *   node index-registry.mjs bootstrap [--root <dir>] [--session-started <ISO>] [--core-dir <dir>]
 *   node index-registry.mjs last-active [--root <dir>]                [--core-dir <dir>]
 *
 * Ships with the plugin by convention; .mjs (Node.js) only, node:* imports only.
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';
import { requireTrustedHome } from './trusted-home.mjs';
import { isCliEntry } from './cli-entry.mjs';
import {
  canonical, classifyRegistration, resolveProjectRoot, stateDir, detectStateHarness, updateManifest, readManifest, writeBootstrap, readBootstrap,
  classifyStamp, writeStamp, STATE_DIRNAME, settleStateFolderName, adoptionCandidate, adoptForeignState, projectMigrationFence, insideMigration,
} from './project-state.mjs';

/**
 * The operational root, anchored to the OS-account home. An unresolvable
 * trusted home throws: the registry is a trust decision, and homedir() is the
 * environment-controlled value that anchor exists to avoid.
 */
export function defaultCoreDir(opts) {
  return join(requireTrustedHome(opts), '.core');
}

const lockPath = (coreDir) => join(coreDir, 'index.lock');
const indexPath = (coreDir) => join(coreDir, 'index.json');
const projectsPath = (coreDir) => join(coreDir, 'projects.json');

function readArray(p, label) {
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, 'utf8')); // parse errors surface loudly — never silently rebuild the registry
  if (!Array.isArray(parsed)) throw new Error(`${label} is not an array: ${p}`);
  return parsed;
}

export function readIndex(coreDir) { return readArray(indexPath(coreDir), 'index.json'); }
export function readProjects(coreDir) { return readArray(projectsPath(coreDir), 'projects.json'); }

function mutateFile(coreDir, file, label, mutator) {
  const dir = coreDir || defaultCoreDir();
  mkdirSync(dir, { recursive: true });
  // Registry writes are rare, short, and must-succeed: give contention a patient
  // (still bounded, still loud) 8s budget rather than the 2s default — under full
  // CPU load (test suites, parallel session startups) 2s produced spurious
  // LOCK_HELD failures from writers that would have succeeded moments later.
  return withFileLock(lockPath(dir), () => {
    const entries = readArray(file(dir), label);
    const out = mutator(entries);
    const next = Array.isArray(out) ? out : out.entries;
    const result = Array.isArray(out) ? undefined : out.result;
    atomicWriteFileSync(file(dir), JSON.stringify(next, null, 2) + '\n');
    return result;
  }, { retries: 80, retryDelayMs: 100 });
}

/** Read-decide-write of projects.json under the registry lock. */
export function mutateProjects(coreDir, mutator) {
  return mutateFile(coreDir, projectsPath, 'projects.json', mutator);
}

/** Read-decide-write of the legacy index.json under the registry lock (migration marks only). */
export function mutateIndex(coreDir, mutator) {
  return mutateFile(coreDir, indexPath, 'index.json', mutator);
}

/**
 * Register `dir` as a project root. Refuses $HOME, anything inside ~/.core, and a
 * folder that already contains a registered project; reports 'ask' for a folder
 * inside a registered project (the caller asks join-or-new, then passes
 * { confirmNew: true }). Idempotent for an already-registered root.
 */
export function registerProject(coreDir, dir, { home, confirmNew = false, offerAdopt = false, harness, now = new Date().toISOString() } = {}) {
  const core = coreDir || defaultCoreDir();
  const homeDir = home || dirname(core);
  const verdict = classifyRegistration(dir, { home: homeDir, coreDir: core });
  if (verdict.action === 'refuse') return verdict;
  if (verdict.action === 'registered') return verdict;
  if (verdict.action === 'ask' && !confirmNew) return verdict;
  const root = canonical(dir);
  // The user is registering this folder: an older `.core` in it takes its visible name before any
  // adoption check reads it.
  settleStateFolderName(root, { coreDir: core });
  if (offerAdopt) {
    const h = harness || detectStateHarness();
    const cand = adoptionCandidate({ root, harness: h, coreDir: core });
    if (cand) return { action: 'adopt-ask', root, old_path: cand.oldPath, last_written: cand.lastWritten };
    // A restore with an unfinished migration is not registered as new: that would lose its offer.
    const fence = projectMigrationFence({ root, harness: h });
    if (fence) return { action: 'held', root, reason: fence };
  }
  return mutateProjects(core, (entries) => {
    if (entries.some((e) => e && typeof e.path === 'string' && canonical(e.path) === root)) {
      return { entries, result: { action: 'registered', root } };
    }
    return { entries: [...entries, { path: root, registered_at: now }], result: { action: 'new', root } };
  });
}

/** Replace a moved project's old path with its new one (keeps registered_at). */
export function recordMove(coreDir, oldPath, newPath) {
  const from = canonical(oldPath);
  const to = canonical(newPath);
  return mutateProjects(coreDir || defaultCoreDir(), (entries) => {
    let found = false;
    const mapped = entries.map((e) => {
      if (e && typeof e.path === 'string' && canonical(e.path) === from) { found = true; return { ...e, path: to, moved_from: from }; }
      return e;
    });
    // Startup registers the new path before the move is noticed: keep one entry per path.
    const seen = new Set();
    const next = [];
    for (const e of found ? [...mapped].sort((a, b) => (b && b.moved_from ? 1 : 0) - (a && a.moved_from ? 1 : 0)) : mapped) {
      const key = e && typeof e.path === 'string' ? canonical(e.path) : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      next.push(e);
    }
    if (!seen.has(to)) next.push({ path: to, registered_at: new Date().toISOString() });
    return { entries: next, result: { moved: found, root: to } };
  });
}

// ---------- per-project records (single-owner files in the project's state) ----------

function rootOrThrow(root, coreDir) {
  if (root) return canonical(root);
  const found = resolveProjectRoot(process.cwd(), { home: dirname(coreDir), coreDir });
  if (!found.root) throw new Error(`no registered project contains ${process.cwd()} (${found.reason})`);
  return found.root;
}

/**
 * Stamp the project's last-active time (full overwrite of a single-owner file) and
 * report what the stamp rules did to the project's state on the way: set aside,
 * moved (the registry follows), another install's, or waiting on a question.
 */
export function touchProject(coreDir, { root, harness = detectStateHarness(), when = new Date().toISOString() } = {}) {
  const core = coreDir || defaultCoreDir();
  const r = rootOrThrow(root, core);
  const events = [];
  const s = stateDir({ root: r, harness, kind: 'durable', coreDir: core, forWrite: true, onEvent: (e) => events.push(e) });
  if (s.status === 'foreign-install') events.push({ kind: 'state-foreign', dir: s.dir });
  if (s.status === 'ask') events.push({ kind: 'state-ask', oldPath: classifyStamp({ root: r, harness, coreDir: core }).oldPath });
  for (const e of events) if (e.kind === 'state-moved' && e.oldPath) recordMove(core, e.oldPath, r);
  atomicWriteFileSync(join(s.dir, 'last-active'), when + '\n');
  return { root: r, harness, last_active: when, events };
}

/**
 * Settle a 'state-ask': the project's state verifies for a path whose folder and
 * parent are both gone. accept-move re-stamps it here and moves the registry entry;
 * fresh sets the state aside unread under superseded/ and starts new.
 */
export function settleState(coreDir, { root, harness = detectStateHarness(), decision } = {}) {
  const core = coreDir || defaultCoreDir();
  const r = rootOrThrow(root, core);
  const verdict = classifyStamp({ root: r, harness, coreDir: core });
  if (verdict.status !== 'ask') return { root: r, status: verdict.status, changed: false };
  // Neither answer re-stamps or sets anything aside while a migration is unfinished.
  const fence = !insideMigration() && projectMigrationFence({ root: r, harness });
  if (fence) return { root: r, status: 'held', reason: fence, changed: false };
  if (decision === 'accept-move') {
    writeStamp({ root: r, harness, coreDir: core });
    recordMove(core, verdict.oldPath, r);
    return { root: r, status: 'moved', oldPath: verdict.oldPath, changed: true };
  }
  if (decision === 'fresh') {
    const dir = join(r, STATE_DIRNAME, harness);
    const aside = join(dir, 'superseded', `unconfirmed-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(aside, { recursive: true });
    for (const name of readdirSync(dir)) if (name !== 'superseded') renameSync(join(dir, name), join(aside, name));
    writeStamp({ root: r, harness, coreDir: core });
    updateManifest({ root: r, harness, coreDir: core });
    return { root: r, status: 'fresh', setAside: aside, changed: true };
  }
  throw new Error('settleState: decision must be accept-move or fresh');
}

/**
 * Record that bootstrap ran, and for which session. `session_started_at` is the
 * first-user-message timestamp the dedup check in protocols/startup.md compares
 * against; a torn or half-written record there reads as "bootstrap never ran"
 * and costs a wrongly repeated startup, so the write is temp-file + rename and
 * the file is owner-only.
 */
export function recordBootstrap(coreDir, { root, harness = detectStateHarness(), sessionStartedAt, completedAt = new Date().toISOString() } = {}) {
  const core = coreDir || defaultCoreDir();
  const r = rootOrThrow(root, core);
  updateManifest({ root: r, harness, coreDir: core });
  const record = { session_started_at: sessionStartedAt ?? null, bootstrap_completed_at: completedAt };
  const path = writeBootstrap({ root: r, harness, coreDir: core, record });
  return { path, record };
}

/** The verified bootstrap record for the project, or null (absent, untrusted, or tampered). */
export function readBootstrapRecord(coreDir, { root, harness = detectStateHarness() } = {}) {
  const core = coreDir || defaultCoreDir();
  let r;
  try { r = rootOrThrow(root, core); } catch { return null; }
  return readBootstrap({ root: r, harness, coreDir: core });
}

/** The project's last-active time, or null when absent or its state is untrusted. */
export function readLastActive(coreDir, { root, harness = detectStateHarness() } = {}) {
  const core = coreDir || defaultCoreDir();
  let r;
  try { r = rootOrThrow(root, core); } catch { return null; }
  const s = stateDir({ root: r, harness, kind: 'durable', coreDir: core });
  if (!s) return null;
  try { return readFileSync(join(s.dir, 'last-active'), 'utf8').trim() || null; } catch { return null; }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--core-dir') out.coreDir = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--when') out.when = argv[++i];
    else if (a === '--session-started') out.sessionStarted = argv[++i];
    else if (a === '--harness') out.harness = argv[++i];
    else if (a === '--confirm-new') out.confirmNew = true;
    else if (a === '--accept-move') out.decision = 'accept-move';
    else if (a === '--fresh') out.decision = 'fresh';
    else if (a === '--yes') out.decision = 'yes';
    else if (a === '--no') out.decision = 'no';
    else if (a === '--set-json') out.setJson = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else out._.push(a);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [sub, target] = args._;
  const coreDir = args.coreDir ? args.coreDir : defaultCoreDir();
  const harness = args.harness || detectStateHarness();
  try {
    switch (sub) {
      case 'register': {
        const r = registerProject(coreDir, target || process.cwd(), { confirmNew: !!args.confirmNew, offerAdopt: true, harness });
        process.stdout.write(JSON.stringify(r) + '\n');
        return r.action === 'refuse' ? 3 : r.action === 'ask' ? 4 : r.action === 'adopt-ask' ? 5 : r.action === 'held' ? 6 : 0;
      }
      case 'adopt-status': {
        const c = adoptionCandidate({ root: args.root || target || process.cwd(), harness, coreDir });
        process.stdout.write(c ? `adopt-ask old_path=${c.oldPath} last_written=${c.lastWritten ?? 'unknown'}\n` : '(none)\n');
        return 0;
      }
      case 'adopt': {
        if (args.decision !== 'yes' && args.decision !== 'no') throw new Error('adopt needs --yes or --no');
        const r = adoptForeignState({ root: args.root || target || process.cwd(), harness, coreDir, decision: args.decision });
        process.stdout.write(JSON.stringify(r) + '\n');
        return r.status === 'not-a-candidate' ? 6 : 0;
      }
      case 'list': {
        for (const e of readProjects(coreDir)) process.stdout.write(`${e.path}\n`);
        return 0;
      }
      case 'touch': {
        const r = touchProject(coreDir, { root: args.root, harness, when: args.when || undefined });
        process.stdout.write(`${r.root} last-active ${r.last_active}\n`);
        for (const e of r.events) {
          const detail = e.setAside ? ` set aside unread at ${e.setAside}` : e.oldPath ? ` (was ${e.oldPath})` : e.dir ? ` (this machine: ${e.dir})` : '';
          process.stdout.write(`${e.kind}${detail}\n`);
        }
        return 0;
      }
      case 'state': {
        const r = settleState(coreDir, { root: args.root, harness, decision: args.decision });
        process.stdout.write(JSON.stringify(r) + '\n'); return 0;
      }
      case 'manifest': {
        const root = rootOrThrow(args.root, coreDir);
        const m = args.setJson
          ? updateManifest({ root, harness, coreDir, fields: JSON.parse(args.setJson) })
          : readManifest({ root, harness, coreDir });
        process.stdout.write(JSON.stringify(m, null, 2) + '\n'); return m ? 0 : 1;
      }
      case 'path': {
        // The one way prose and callers name a file in a project's state: this verb asks
        // stateDir where it lives, so a read-only folder, a fenced migration or another
        // install's state routes the same way it does for every script.
        const kind = args.kind === 'hot' ? 'hot' : args.kind === 'durable' ? 'durable' : null;
        if (!kind) throw new Error('path needs --kind durable|hot');
        if (args.name && (isAbsolute(args.name) || args.name.split(/[\\/]/).includes('..'))) throw new Error('path --name must be a relative name inside the state');
        const root = rootOrThrow(args.root, coreDir);
        const s = stateDir({ root, harness, kind, coreDir, forWrite: true });
        process.stdout.write((args.name ? join(s.dir, args.name) : s.dir) + '\n');
        return 0;
      }
      case 'bootstrap': {
        const r = recordBootstrap(coreDir, { root: args.root, harness, sessionStartedAt: args.sessionStarted || null });
        process.stdout.write(`${r.path}\n`); return 0;
      }
      case 'bootstrap-status': {
        const rec = readBootstrapRecord(coreDir, { root: args.root, harness });
        process.stdout.write((rec && rec.session_started_at ? rec.session_started_at : '(none)') + '\n');
        return rec ? 0 : 1;
      }
      case 'last-active': {
        const v = readLastActive(coreDir, { root: args.root, harness });
        process.stdout.write((v || '(none)') + '\n'); return v ? 0 : 1;
      }
      default:
        process.stderr.write('usage: index-registry.mjs <register|list|touch|state|manifest|path|bootstrap|bootstrap-status|last-active> [dir] [--root dir] [--when ISO] [--session-started ISO] [--harness h] [--confirm-new] [--accept-move|--fresh] [--set-json json] [--core-dir dir]\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`index-registry: ${e.message}\n`);
    return 1;
  }
}

if (isCliEntry(import.meta.url)) process.exit(main());
