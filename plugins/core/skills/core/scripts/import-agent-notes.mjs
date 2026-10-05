#!/usr/bin/env node
/**
 * One-time copy of the agent's own notes from the old shared ~/.core folder into this project.
 *
 * The agent profile (and an older dm-profile.md, kept under its own name), saved agents, task
 * configurations and topic vocabulary live in <project>/_core/_agent/. Research documents live in
 * <project>/_outputs/research/ and are copied only when asked (--research), because the old library
 * mixes every project's research.
 *
 * Each family is copied into a staging folder, recorded as pending in
 * _core/_agent/import-receipt.json with a sha256 per file, published into place without replacing
 * anything, then recorded as done. A family recorded as done (copied, absent, local-present or
 * source-is-link) is never looked at again, so a deleted local copy never falls back to the old
 * folder. A pending family is finished on the next run when its published files still match, and
 * held when something else is there. A local copy that was there first wins. The old folder is only
 * read. Anything not finished is reported with its stage and error, and the run exits 1.
 *
 *   node import-agent-notes.mjs --root <project> [--research]
 */
import { lstatSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, linkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ensureProjectArtifactDir, assertArtifactFile, projectArtifactRoot } from './project-artifacts.mjs';
import { requireTrustedHome } from './trusted-home.mjs';
import { isCliEntry } from './cli-entry.mjs';

export const RECEIPT = 'import-receipt.json';
const DONE = new Set(['copied', 'absent', 'local-present', 'source-is-link']);
const FAMILIES = [
  { name: 'profile', from: 'agent-profile.md', to: 'agent-profile.md', kind: 'file' },
  { name: 'dm-profile', from: 'dm-profile.md', to: 'dm-profile.md', kind: 'file' },
  { name: 'topics', from: 'topics.md', to: 'topics.md', kind: 'file' },
  { name: 'agents', from: 'agents', to: 'agents', kind: 'dir' },
  { name: 'task-configs', from: 'task-configs', to: 'task-configs', kind: 'dir' },
];

function lstatOrNull(p) {
  try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const stageErr = (stage, e) => Object.assign(new Error(e.message), { stage, code: e.code || 'error' });

// Copies regular files only; links and anything else are listed, never followed.
function copyTree(src, dest, rel, out) {
  let st;
  try { st = lstatSync(src); } catch (e) { throw stageErr('read', e); }
  if (st.isFile() && !st.isSymbolicLink()) {
    let bytes;
    try { bytes = readFileSync(src); } catch (e) { throw stageErr('read', e); }
    try { writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { throw stageErr('write', e); }
    out.files[rel || '.'] = sha(bytes);
  } else if (st.isDirectory() && !st.isSymbolicLink()) {
    try { mkdirSync(dest, { mode: 0o700 }); } catch (e) { throw stageErr('write', e); }
    let names;
    try { names = readdirSync(src).sort(); } catch (e) { throw stageErr('read', e); }
    for (const name of names) copyTree(join(src, name), join(dest, name), rel ? `${rel}/${name}` : name, out);
  } else {
    out.omitted.push(rel || '.');
  }
}

// The hashes of what is at `dest` now, in copyTree's shape; null when anything in it is a link or
// neither a file nor a folder.
function hashTree(dest, rel = '', files = {}) {
  const st = lstatOrNull(dest);
  if (!st || st.isSymbolicLink()) return null;
  if (st.isFile()) { files[rel || '.'] = sha(readFileSync(dest)); return files; }
  if (!st.isDirectory()) return null;
  for (const name of readdirSync(dest)) if (!hashTree(join(dest, name), rel ? `${rel}/${name}` : name, files)) return null;
  return files;
}
const sameFiles = (a, b) => !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function readReceipt(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { version: 1, families: {} } : null; }
  try {
    const r = JSON.parse(text);
    const f = r?.families;
    return f && typeof f === 'object' && !Array.isArray(f) ? r : null;
  } catch { return null; }
}

function saveReceipt(file, receipt) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(tmp, file);
}

// Publishes without replacing: a file by hard link (fails if anything is there), a folder by rename
// after checking nothing is there.
function publish(staged, dest, kind) {
  if (kind === 'file') { linkSync(staged, dest); return; }
  if (lstatOrNull(dest)) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
  renameSync(staged, dest);
}

function runFamily({ name, source, dest, kind, dir }, receipt, save, now) {
  const prior = receipt.families[name];
  if (prior && DONE.has(prior.result)) return { family: name, result: 'already-decided' };
  const record = (entry) => { receipt.families[name] = { ...entry, at: now.toISOString() }; save(); return { family: name, ...entry }; };
  if (prior?.result === 'pending') {
    const stagingDir = typeof prior.staging === 'string' && /^\.importing-[\w-]+$/.test(prior.staging) ? join(dir, prior.staging) : null;
    if (lstatOrNull(dest)) {
      if (!sameFiles(hashTree(dest), prior.files)) return { family: name, result: 'held', stage: 'publish', reason: 'something other than the pending copy is at the destination' };
      if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
      return record({ ...prior, result: 'copied', staging: undefined });
    }
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
  const local = lstatOrNull(dest);
  if (local) {
    const ok = kind === 'file' ? local.isFile() : local.isDirectory();   // lstat: a link is neither
    return ok ? record({ result: 'local-present' }) : { family: name, result: 'held', stage: 'local', reason: 'the local note is a link or the wrong type' };
  }
  let src;
  try { src = lstatOrNull(source); } catch (e) { return { family: name, result: 'not-copied', stage: 'read', code: e.code }; }
  if (!src) return record({ result: 'absent' });
  if (src.isSymbolicLink()) return record({ result: 'source-is-link', source });
  const staging = `.importing-${name}-${randomBytes(4).toString('hex')}`;
  const out = { files: {}, omitted: [] };
  try {
    try { mkdirSync(join(dir, staging), { mode: 0o700 }); } catch (e) { throw stageErr('write', e); }
    copyTree(source, join(dir, staging, 'payload'), '', out);
  } catch (e) {
    rmSync(join(dir, staging), { recursive: true, force: true });
    return { family: name, result: 'not-copied', stage: e.stage || 'write', code: e.code };
  }
  record({ result: 'pending', source, staging, files: out.files, omitted: out.omitted });
  try { publish(join(dir, staging, 'payload'), dest, kind); }
  catch (e) { return { family: name, result: 'held', stage: 'publish', code: e.code, reason: 'the copy is staged and recorded as pending' }; }
  rmSync(join(dir, staging), { recursive: true, force: true });
  return record({ result: 'copied', source, files: out.files, omitted: out.omitted });
}

/** Which local notes can be read as they are: a real file, or a real folder for agents and task-configs. */
function noteCustody(dir) {
  const notes = {};
  for (const { to, kind } of FAMILIES) {
    const st = lstatOrNull(join(dir, to));
    notes[to] = !st ? 'absent' : st.isSymbolicLink() ? 'link' : (kind === 'file' ? st.isFile() : st.isDirectory()) ? 'ok' : 'wrong-type';
  }
  return notes;
}

export function importAgentNotes({ root, home = requireTrustedHome(), research = false, now = new Date() } = {}) {
  root = projectArtifactRoot(resolve(root));
  const dir = ensureProjectArtifactDir(root, '_agent');
  const receiptFile = join(dir, RECEIPT);
  assertArtifactFile(dir, receiptFile);
  const receipt = readReceipt(receiptFile);
  if (!receipt) return { status: 'receipt-invalid', dir, results: [], notes: noteCustody(dir) };
  const save = () => saveReceipt(receiptFile, receipt);
  const old = join(home, '.core');
  const plan = FAMILIES.map(f => ({ name: f.name, source: join(old, f.from), dest: join(dir, f.to), kind: f.kind, dir }));
  if (research) {
    const outputs = join(root, '_outputs');
    const st = lstatOrNull(outputs);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return { status: 'outputs-unsafe', dir, results: [], notes: noteCustody(dir) };
    if (!st) mkdirSync(outputs, { mode: 0o755 });
    plan.push({ name: 'research', source: join(old, 'research'), dest: join(outputs, 'research'), kind: 'dir', dir });
  }
  const results = [];
  for (const p of plan) {
    try { results.push(runFamily(p, receipt, save, now)); }
    catch (e) { results.push({ family: p.name, result: 'not-copied', stage: 'receipt', code: e.code || 'error' }); }
  }
  const unfinished = results.some((r) => r.result !== 'already-decided' && !DONE.has(r.result));
  return { status: unfinished ? 'partial' : 'ok', dir, results, notes: noteCustody(dir) };
}

if (isCliEntry(import.meta.url)) {
  const a = process.argv.slice(2);
  const at = a.indexOf('--root');
  try {
    const r = importAgentNotes({ root: at >= 0 ? a[at + 1] : process.cwd(), research: a.includes('--research') });
    for (const x of r.results) if (x.result !== 'already-decided') {
      const why = [x.source && `from ${x.source}`, x.stage && `at ${x.stage}`, x.code, x.reason, x.omitted?.length && `not copied: ${x.omitted.join(', ')}`].filter(Boolean).join('; ');
      process.stdout.write(`${x.family}: ${x.result}${why ? ` (${why})` : ''}\n`);
    }
    const ok = Object.entries(r.notes).filter(([, v]) => v === 'ok').map(([k]) => k);
    const refused = Object.entries(r.notes).filter(([, v]) => v === 'link' || v === 'wrong-type').map(([k, v]) => `${k} (${v})`);
    process.stdout.write(`readable: ${ok.join(', ') || 'none'}${refused.length ? `; do not read: ${refused.join(', ')}` : ''}\n`);
    process.stdout.write(`${r.status} ${r.dir}\n`);
    process.exit(r.status === 'ok' ? 0 : 1);
  } catch (e) { process.stderr.write(`import-agent-notes: ${e.code || ''} ${e.message}\n`); process.exit(1); }
}
