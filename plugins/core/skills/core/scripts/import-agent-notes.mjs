#!/usr/bin/env node
/**
 * One-time copy of the agent's own notes from the old shared ~/.core folder into this project.
 *
 * The agent profile, saved agents, task configurations and topic vocabulary live in
 * <project>/.core/_agent/. Research documents live in <project>/_outputs/research/ and are copied
 * only when asked (--research), because the old library mixes every project's research.
 *
 * Each family is decided once and recorded in .core/_agent/import-receipt.json with the source path
 * and a sha256 per copied file. A recorded family is never looked at again, so a missing or deleted
 * local copy never falls back to the old shared folder. A local copy that already exists wins and
 * nothing is copied over it. The old folder is only read.
 *
 *   node import-agent-notes.mjs --root <project> [--research]
 */
import { lstatSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ensureProjectArtifactDir, assertArtifactFile, projectArtifactRoot } from './project-artifacts.mjs';
import { requireTrustedHome } from './trusted-home.mjs';
import { isCliEntry } from './cli-entry.mjs';

export const RECEIPT = 'import-receipt.json';
const FAMILIES = [
  { name: 'profile', from: ['agent-profile.md', 'dm-profile.md'], to: 'agent-profile.md' },
  { name: 'topics', from: ['topics.md'], to: 'topics.md' },
  { name: 'agents', from: ['agents'], to: 'agents' },
  { name: 'task-configs', from: ['task-configs'], to: 'task-configs' },
];

function lstatOrNull(p) {
  try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Copies regular files only; links and anything else are listed, never followed.
function copyTree(src, dest, rel, out) {
  const st = lstatSync(src);
  if (st.isFile() && !st.isSymbolicLink()) {
    const bytes = readFileSync(src);
    writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    out.files[rel || '.'] = sha(bytes);
  } else if (st.isDirectory() && !st.isSymbolicLink()) {
    mkdirSync(dest, { mode: 0o700 });
    for (const name of readdirSync(src).sort()) copyTree(join(src, name), join(dest, name), rel ? `${rel}/${name}` : name, out);
  } else {
    out.omitted.push(rel || '.');
  }
}

function readReceipt(file) {
  try { const r = JSON.parse(readFileSync(file, 'utf8')); return r && typeof r.families === 'object' && r.families ? r : null; }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, families: {} }; return null; }
}

function decide(family, sources, dest, out) {
  for (const source of sources) {
    const st = lstatOrNull(source);
    if (!st) continue;
    if (st.isSymbolicLink()) return { result: 'source-is-link', source };
    try { copyTree(source, dest, '', out); }
    catch (e) {
      if (e.code === 'EEXIST') return { result: 'local-present' };
      if (e.code === 'EACCES' || e.code === 'EPERM') return null; // not recorded: tried again next time
      throw e;
    }
    return { result: 'copied', source, files: out.files, omitted: out.omitted };
  }
  return { result: 'absent' };
}

export function importAgentNotes({ root, home = requireTrustedHome(), research = false, now = new Date() } = {}) {
  root = projectArtifactRoot(resolve(root));
  const dir = ensureProjectArtifactDir(root, '_agent');
  const receiptFile = join(dir, RECEIPT);
  assertArtifactFile(dir, receiptFile);
  const receipt = readReceipt(receiptFile);
  if (!receipt) return { status: 'receipt-unreadable', dir, results: [] };
  const old = join(home, '.core');
  const plan = FAMILIES.map(f => ({ name: f.name, sources: f.from.map(n => join(old, n)), dest: join(dir, f.to) }));
  if (research) {
    const outputs = join(root, '_outputs');
    const st = lstatOrNull(outputs);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return { status: 'outputs-unsafe', dir, results: [] };
    if (!st) mkdirSync(outputs, { mode: 0o755 });
    plan.push({ name: 'research', sources: [join(old, 'research')], dest: join(outputs, 'research') });
  }
  const results = [];
  for (const { name, sources, dest } of plan) {
    if (receipt.families[name]) { results.push({ family: name, result: 'already-decided' }); continue; }
    const r = decide(name, sources, dest, { files: {}, omitted: [] });
    if (!r) { results.push({ family: name, result: 'source-unreadable' }); continue; }
    receipt.families[name] = { ...r, at: now.toISOString() };
    results.push({ family: name, ...r });
  }
  const tmp = `${receiptFile}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(tmp, receiptFile);
  return { status: 'ok', dir, results };
}

if (isCliEntry(import.meta.url)) {
  const a = process.argv.slice(2);
  const at = a.indexOf('--root');
  try {
    const r = importAgentNotes({ root: at >= 0 ? a[at + 1] : process.cwd(), research: a.includes('--research') });
    for (const x of r.results) if (x.result !== 'already-decided') process.stdout.write(`${x.family}: ${x.result}${x.source ? ` from ${x.source}` : ''}${x.omitted?.length ? ` (not copied: ${x.omitted.join(', ')})` : ''}\n`);
    process.stdout.write(`${r.status} ${r.dir}\n`);
    process.exit(r.status === 'ok' ? 0 : 1);
  } catch (e) { process.stderr.write(`import-agent-notes: ${e.code || ''} ${e.message}\n`); process.exit(1); }
}
