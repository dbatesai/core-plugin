#!/usr/bin/env node
/**
 * mailbox.mjs — the per-project mailbox: inbound messages TO the agent running a
 * project, from David or other agents. Plain files in `<project>/_mailbox/`,
 * discoverable via the project registry. Checked at startup + on demand (no hook,
 * no scheduler — David 2026-07-12). Standard surface for every CORE project.
 *
 * INDEPENDENCE INVARIANT (David 2026-07-12): zero dependency on collab-plugin. This
 * script imports only node stdlib. Collab MAY adopt the convention as an optional
 * sender; core-plugin never imports/requires/assumes collab, and the mailbox does
 * not ride collab's transport. It is plain files.
 *
 * UNTRUSTED INPUT: a message is content authored by a sender (maybe another agent,
 * maybe automated). It is surfaced as DATA and NEVER executed as instructions — the
 * agent reading it at startup treats it like any inbound note, not a command. The
 * `from` field is self-declared and unauthenticated; surfaces render it as a CLAIM.
 *
 * SAFE-BY-LOCATION: `_mailbox/` is a sibling of `_memories/`, and every memory reader
 * roots at `_memories/` and never walks the project root — so a message is never
 * indexed or retrieved as a memory unit. (The underscore prefix is belt-and-braces
 * for a hypothetical future root-walker; the real invariant is "no reader walks root".)
 *
 * Ops:
 *   node mailbox.mjs list <project> [--top N] [--all]        # unread (files in _mailbox/, not archive/)
 *   node mailbox.mjs read <project> <file>                    # print a message body
 *   node mailbox.mjs archive <project> <file>                 # mark read (move to archive/); idempotent
 *   node mailbox.mjs post --to <id|path> --from <s> --topic <t> --body <file|->
 *
 * <project> is a path (or '.') or a registered workspace id. `post --to` is a
 * registered id or a path to a real project. An unresolved target FAILS LOUD
 * (exit 2) — a comms channel must never silently drop a message.
 *
 * Self-caught 2026-07-20: `list`/`read`/`archive` used to resolve <project>
 * with a bare `resolve()` instead of the registry-aware resolveTarget() that
 * `post --to` already used -- a workspace id (e.g. an id NOT containing '/'
 * or '.') silently resolved relative to the CALLER'S cwd instead of through
 * the registry, and a wrong/unregistered id landed on a nonexistent
 * directory and printed "no unread messages" instead of failing loud. That
 * is indistinguishable from a genuinely empty mailbox and is exactly the
 * silent-drop the FAILS LOUD invariant above was supposed to rule out --
 * caught only because a 172-message backlog turned out to be sitting
 * unseen behind it. All three ops now route through resolveTarget() too.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only, macOS + Windows.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, linkSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { slugify } from './project-slug.mjs'; // centralized slug logic (guard ratchet)

const INDEX_PATH = join(homedir(), '.core', 'index.json');
const LIST_CAP = 5; // startup/on-demand surface cap; --all overrides

function expandHome(p) { return p.startsWith('~') ? join(homedir(), p.slice(1)) : p; }

/** Read the workspace registry; [] when absent/malformed (never throws). */
function readIndex() {
  try {
    const j = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.workspaces || []);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Is this directory a real project (registered, or carries CORE markers)? */
function isProjectDir(absPath) {
  if (existsSync(join(absPath, 'workspace.json'))) return true;
  if (existsSync(join(absPath, '_memories')) || existsSync(join(absPath, 'PROJECT.md'))) return true;
  const reg = readIndex().map(w => resolve(expandHome(String(w.path || ''))));
  return reg.includes(resolve(absPath));
}

/**
 * Resolve a project TARGET (id or path) to an absolute directory, FAILING LOUD on
 * anything unresolved or unsafe. The mailbox is keyed by PATH — two workspace ids at
 * one path share one mailbox by design (they are the same folder). A `--to <path>`
 * must be a real project (registered or CORE-marked), so `post` can't write a
 * `_mailbox/` into an arbitrary directory (path-traversal / write-anywhere guard).
 */
function resolveTarget(idOrPath, { forWrite = false } = {}) {
  if (!idOrPath) throw new Error('no target given');
  const looksPath = idOrPath === '.' || idOrPath.includes('/') || idOrPath.includes('\\') || idOrPath.startsWith('~');
  if (looksPath) {
    const abs = resolve(expandHome(idOrPath));
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`target path is not a directory: ${abs}`);
    if (forWrite && !isProjectDir(abs)) throw new Error(`refusing to post: ${abs} is not a registered/CORE project (write-anywhere guard)`);
    return abs;
  }
  // id → path via the registry
  const matches = readIndex().filter(w => w.workspace_id === idOrPath || w.id === idOrPath);
  if (!matches.length) throw new Error(`unknown project id '${idOrPath}' — not in ${INDEX_PATH}. Message NOT delivered.`);
  const paths = [...new Set(matches.map(w => resolve(expandHome(String(w.path || '')))))];
  if (paths.length > 1) throw new Error(`id '${idOrPath}' resolves to multiple paths (${paths.join(', ')}) — ambiguous; post by path`);
  const abs = paths[0];
  if (!abs || !existsSync(abs)) throw new Error(`project '${idOrPath}' path does not exist: ${abs} (stale registry?). Message NOT delivered.`);
  return abs;
}

const mailboxDir = (proj) => join(proj, '_mailbox');
const archiveDir = (proj) => join(mailboxDir(proj), 'archive');

/** Strip YAML frontmatter, returning {fm, body}. Lenient: no frontmatter → {}. */
function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text.trim() };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length).trim() };
}

/** Best-effort routing fields from a filename: <from>--<topic>--<date>[-n]. Robust to junk. */
function parseName(name) {
  const stem = name.replace(/\.md$/i, '');
  const parts = stem.split('--');
  if (parts.length >= 3) return { from: parts[0], topic: parts.slice(1, -1).join('--'), date: parts[parts.length - 1] };
  return { from: 'unknown', topic: stem, date: 'unknown' }; // hand-dropped / malformed
}

/** Unread messages: *.md in _mailbox/ (not archive/, not dotfiles). Missing dir → []. */
export function listMessages(projectPath) {
  const dir = mailboxDir(resolveTarget(projectPath));
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md') || name.startsWith('.')) continue; // .md only, skip dotfiles/junk
    const full = join(dir, name);
    let st; try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue; // skips archive/ and any subdir
    const fromName = parseName(name);
    let fm = {}; try { fm = parseFrontmatter(readFileSync(full, 'utf8')).fm; } catch { /* unreadable → filename only */ }
    out.push({
      file: name,
      from: fm.from || fromName.from,        // frontmatter preferred, filename fallback
      topic: fm.subject || fm.topic || fromName.topic,
      date: fm.date || fromName.date,
      mtimeMs: st.mtimeMs,
    });
  }
  // newest first, deterministic tiebreak by filename
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

export function readMessage(projectPath, file) {
  const full = join(mailboxDir(resolveTarget(projectPath)), basename(file));
  return readFileSync(full, 'utf8');
}

// K16 (Hale's audit, 2026-07-16): archiveMessage renamed straight onto
// `join(archiveDir, basename(file))` with no collision check — a bare
// filesystem rename onto an existing path silently REPLACES it. The inbox's
// own collision guard (atomicCreate, below) only scopes to the inbox
// directory, never to archive/, so two distinct messages that happen to slug
// to the same <from>--<topic>--<date> basename (one already archived, a
// second one posted and archived later) would silently destroy the first
// archived message on the second archive — a real loss of comms history,
// exactly the kind of thing this channel exists to preserve. Fixed:
// disambiguate the destination the same way atomicCreate disambiguates the
// inbox, never overwrite an existing archived file.
// Atomic move via link-then-unlink (same technique atomicCreate uses below):
// linkSync fails EEXIST rather than silently replacing, closing the TOCTOU
// gap a check-then-renameSync would leave open under concurrent archiving.
function moveNonColliding(src, dir, filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? filename : `${base}-${i + 1}${ext}`;
    try { linkSync(src, join(dir, candidate)); unlinkSync(src); return candidate; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`archiveMessage: too many filename collisions in ${dir} for ${filename}`);
}

/** Move a message to archive/ (mark read). Idempotent: already-archived/absent → no-op. */
export function archiveMessage(projectPath, file) {
  const proj = resolveTarget(projectPath);
  const src = join(mailboxDir(proj), basename(file));
  if (!existsSync(src)) return false; // already archived or never existed
  const dir = archiveDir(proj);
  mkdirSync(dir, { recursive: true });
  moveNonColliding(src, dir, basename(file));
  return true;
}

/**
 * Atomically place NEW content under dir with a collision-safe name. Writes a temp
 * file then hard-links it into place (link fails EEXIST → try next suffix), so a
 * reader never sees a half-written file (F7) and concurrent posts never clobber (F6).
 * Falls back to exclusive-create write if link is unavailable (cross-device, etc.).
 */
function atomicCreate(dir, base, ext, content) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${base}.tmp-${process.pid}-${realish()}`);
  writeFileSync(tmp, content);
  try {
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? `${base}${ext}` : `${base}-${i + 1}${ext}`;
      const target = join(dir, name);
      try { linkSync(tmp, target); return name; }
      catch (e) {
        if (e.code === 'EEXIST') continue;
        // link unsupported → exclusive-create write with the same suffix loop
        try { writeFileSync(target, content, { flag: 'wx' }); return name; }
        catch (e2) { if (e2.code === 'EEXIST') continue; throw e2; }
      }
    }
    throw new Error('too many filename collisions');
  } finally {
    try { unlinkSync(tmp); } catch { /* fallback path never created tmp link */ }
  }
}
// A deterministic-enough disambiguator without Date.now/Math.random (both fine here,
// but keep it dependency-light): high-res counter.
let _seq = 0;
function realish() { return (process.hrtime.bigint().toString(36) + (_seq++).toString(36)); }

/**
 * Ensure `_mailbox/` is git-ignored in the target project (governance control, not a
 * doc sentence — Crest's boundary + the adversarial critic). The mailbox is transient,
 * potentially cross-project-sensitive inbound comms; unlike the memory store it must
 * never be committed/pushed. Idempotent append to <project>/.gitignore.
 */
function ensureGitignored(project) {
  const gi = join(project, '.gitignore');
  let cur = '';
  try { cur = readFileSync(gi, 'utf8'); } catch { /* none yet */ }
  if (/^_mailbox\/?\s*$/m.test(cur)) return;
  const add = (cur && !cur.endsWith('\n') ? '\n' : '') + '_mailbox/\n';
  try { writeFileSync(gi, cur + add); } catch { /* read-only tree — best effort */ }
}

/** Post a message into a target project's mailbox. Returns the written filename. */
export function postMessage({ to, from, topic, body, date }) {
  const target = resolveTarget(to, { forWrite: true });
  ensureGitignored(target);
  const d = date || new Date().toISOString().slice(0, 10);
  const base = `${slugify(from, 'sender')}--${slugify(topic, 'message')}--${d}`;
  const front = `---\nfrom: ${from}\ntopic: ${topic}\ndate: ${d}\n---\n\n`;
  const name = atomicCreate(mailboxDir(target), base, '.md', front + String(body).trim() + '\n');
  return { file: name, mailbox: mailboxDir(target) };
}

function readBodyArg(v) {
  if (v === '-') return readFileSync(0, 'utf8');
  if (v && (v.includes('/') || existsSync(v))) return readFileSync(v, 'utf8');
  return v || '';
}

function main(argv) {
  const op = argv[0];
  try {
    if (op === 'list') {
      const proj = argv[1] || '.';
      const all = argv.includes('--all');
      const topIdx = argv.indexOf('--top');
      const cap = all ? Infinity : (topIdx >= 0 ? Number(argv[topIdx + 1]) || LIST_CAP : LIST_CAP);
      const msgs = listMessages(proj);
      if (!msgs.length) { process.stdout.write('mailbox: no unread messages\n'); return 0; }
      process.stdout.write(`mailbox: ${msgs.length} unread\n`);
      for (const m of msgs.slice(0, cap)) {
        // sender is unauthenticated — render as a CLAIM (F15)
        process.stdout.write(`- [${m.date}] claims-from ${m.from} · ${m.topic}  (${m.file})\n`);
      }
      if (msgs.length > cap) process.stdout.write(`  …and ${msgs.length - cap} more (--all to see)\n`);
      return 0;
    }
    if (op === 'read') { process.stdout.write(readMessage(argv[1] || '.', argv[2])); return 0; }
    if (op === 'archive') {
      const moved = archiveMessage(argv[1] || '.', argv[2]);
      process.stdout.write(moved ? `archived ${argv[2]}\n` : `nothing to archive (${argv[2]} not in inbox)\n`);
      return 0;
    }
    if (op === 'post') {
      const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
      const to = flag('to'), from = flag('from'), topic = flag('topic');
      if (!to || !from || !topic) { process.stderr.write('post requires --to --from --topic (and --body <file|->)\n'); return 2; }
      const body = readBodyArg(flag('body') ?? '-');
      const res = postMessage({ to, from, topic, body });
      process.stdout.write(`delivered: ${join(res.mailbox, res.file)}\n`);
      return 0;
    }
    process.stderr.write('usage: mailbox.mjs list|read|archive|post ...\n');
    return 2;
  } catch (e) {
    process.stderr.write(`mailbox error: ${e.message}\n`);
    return 2; // fail loud — never silently drop
  }
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
