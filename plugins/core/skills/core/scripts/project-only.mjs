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
 * The folder's existence is also a disable-only hint for the automatic hooks: where it is
 * present they exit before any registry lookup or log write. The hint can only switch
 * automation off; it grants nothing.
 *
 * CLI: node project-only.mjs startup --root <dir> [--harness <h>] [--session <id>]
 *      node project-only.mjs status|capture-status --root <dir> [--harness <h>]
 *      purge, retention and finalize answer `unavailable`; anything else is refused.
 * Prints one JSON line. Exits 2 on a refused root or bad arguments.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, parse, sep } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isCliEntry } from './cli-entry.mjs';

export const PROJECT_ONLY_DIR = '_project-only';
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_RE = /^[^\r\n]{1,80}$/;

/** True when `cwd` carries the project-only marker folder. Disable-only: it never grants anything. */
export function projectOnlyHint(cwd) {
  try { return !!cwd && existsSync(join(String(cwd), '.core', PROJECT_ONLY_DIR)); } catch { return false; }
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

const UNAVAILABLE = {
  purge: 'the captured-turn purge is not available in project-only mode yet; run it in a normal session',
  retention: 'retention is not available in project-only mode',
  finalize: 'project-only /finalize is not available yet',
};

export function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i];
  const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); return o.status === 'ok' ? 0 : 2; };
  if (UNAVAILABLE[cmd]) return out({ status: 'unavailable', state: 'unavailable', operation: cmd, reason: UNAVAILABLE[cmd] });
  const run = { startup, status, 'capture-status': captureStatus }[cmd];
  if (!run) return out({ status: 'refused', state: 'unknown-command', reason: `project-only supports startup, status and capture-status, not ${cmd || '(none)'}` });
  const ctx = projectOnlyContext({ root: opt.root, harness: opt.harness || 'claude-code', session: opt.session || null, operation: cmd });
  if (!ctx.ok) return out({ status: 'refused', ...ctx });
  return out(run(ctx));
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
