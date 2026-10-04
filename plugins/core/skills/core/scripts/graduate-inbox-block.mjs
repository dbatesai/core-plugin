#!/usr/bin/env node
/**
 * graduate-inbox-block.mjs — the mechanical half of graduating one inbox block into a unit.
 *
 * /process-memory decides WHAT a block becomes (frontmatter adjustments, a Resolution for a
 * mode-C question); this script does the move so the acceptance record is never lost or doubled:
 * under the project intake lock it writes the unit first (atomically, with its creation baseline
 * stamped, so later writers treat it as CORE's), then removes the block from inbox.md by a temp
 * file renamed into place. A crash between the two leaves both copies — land-observation counts
 * that as one acceptance — and the next run finishes the removal. It never yields zero.
 *
 * Identity fields (`id`, `source`, `quoted-sha256`, `handoff-*`) are carried unchanged and cannot
 * be overridden; the inbox-only `mode` and `judgment-needed` are dropped; `status` becomes active.
 *
 * The inbox copy is removed only once a complete, valid, stamped unit exists: a composed unit is
 * checked against the store schema first; an existing unit must hold the block's body, not just
 * its header; a creation stamp that fails keeps the block (pending:baseline-failed) and the retry
 * stamps the verified unit.
 *
 * Outcomes: graduated · graduated-resumed (unit already written, block removed now) ·
 * already-graduated · refused:<reason> · pending:<reason>.
 *
 * CLI: node graduate-inbox-block.mjs <project> --id <obs-…> [--set '<json frontmatter overrides>']
 *        [--resolution-file <path>]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from './cli-entry.mjs';
import { withFileLock } from './file-lock.mjs';
import { createFile, classifyFileLifecycle, stampCreatedBaseline } from './lifecycle-detect.mjs';
import { checkSchema } from './check-units.mjs';
import { loadUnit } from './priority.mjs';
import { parseFlatFrontmatter } from './frontmatter-flat.mjs';

const INBOX_ONLY = new Set(['mode', 'judgment-needed']);
const IMMUTABLE = (k) => k === 'id' || k === 'source' || k === 'quoted-sha256' || k.startsWith('handoff-');
const ID_RE = /^obs-[a-z0-9-]{1,120}$/;
const SAFE_VALUE = /^[^\r\n]{0,400}$/;

/** Locate a block by id: the opening `---` line index, the closing fence, and where its body ends. */
function locate(lines, id) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== '---') { i++; continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j >= lines.length) return null;
    const fm = {};
    for (const raw of lines.slice(i + 1, j)) { const m = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/); if (m) fm[m[1]] = m[2].trim(); }
    let k = j + 1;
    while (k < lines.length && lines[k].trim() !== '---') k++;
    if (fm.id === id) return { start: i, fmEnd: j, end: k, fm, body: lines.slice(j + 1, k).join('\n').trim() };
    i = k;
  }
  return null;
}

/** The unit file for an id in whichever observations/<month>/ holds it, else null. */
function findUnit(project, id) {
  const root = join(project, '_memories', 'observations');
  try { for (const m of readdirSync(root).sort().reverse()) { const p = join(root, m, `${id}.md`); if (existsSync(p)) return p; } } catch { /* none */ }
  return null;
}

/** Schema FAILs for a composed unit, checked from a temp copy before it enters the store. */
function schemaFails(text, id) {
  const dir = mkdtempSync(join(tmpdir(), 'grad-check-'));
  try {
    const p = join(dir, `${id}.md`);
    writeFileSync(p, text);
    const report = [];
    checkSchema([loadUnit(p)], dir, report);
    return report.filter(r => r.level === 'FAIL').map(r => r.check);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A failed creation stamp, as a pending state the caller can retry; null when stamped. */
const stampFailure = (stamp, id, path) => (stamp && stamp.stamped === false
  ? { status: 'pending:baseline-failed', id, path, detail: stamp.reason || stamp.outcome || 'unstamped' } : null);

const sameIdentity = (a, b) => Object.keys({ ...a, ...b }).filter(IMMUTABLE).every(k => (a[k] ?? null) === (b[k] ?? null));

export function graduateInboxBlock(project, { id, set = {}, resolution = '', now = new Date().toISOString(), lockOpts = {}, fsOps = {}, create = createFile, stamp = stampCreatedBaseline } = {}) {
  if (!ID_RE.test(String(id))) return { status: 'refused:bad-id', id };
  for (const [k, v] of Object.entries(set)) {
    if (IMMUTABLE(k) || INBOX_ONLY.has(k)) return { status: 'refused:immutable-field', id, field: k };
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(k) || !SAFE_VALUE.test(String(v))) return { status: 'refused:bad-override', id, field: k };
  }
  if (/^\s*---\s*$/m.test(resolution)) return { status: 'refused:bad-resolution', id };
  const ops = { writeFileSync, renameSync, rmSync, ...fsOps };
  const inbox = join(project, 'inbox.md');
  const lockPath = join(project, '_memories', '_lib', 'intake.lock');
  mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
  try {
    return withFileLock(lockPath, () => {
      const text = existsSync(inbox) ? readFileSync(inbox, 'utf8') : '';
      const lines = text.split(/\r?\n/);
      const hit = locate(lines, id);
      if (!hit) { const found = findUnit(project, id); return found ? { status: 'already-graduated', id, path: found } : { status: 'refused:not-found', id }; }
      const unitPath = findUnit(project, id) || join(project, '_memories', 'observations', (hit.fm['extracted-at'] || now).slice(0, 7), `${id}.md`);

      let resumed = false;
      if (existsSync(unitPath)) {
        const [unitFm, unitBody] = parseFlatFrontmatter(readFileSync(unitPath, 'utf8'));
        // a matching header is not enough: the inbox copy is removed only when the unit still holds its body
        if (!sameIdentity(unitFm, hit.fm) || (hit.body && !String(unitBody).includes(hit.body))) return { status: 'refused:unit-conflict', id, path: unitPath };
        // the same readiness as a new unit: schema-valid, and not malformed; nothing is repaired here
        const fails = schemaFails(readFileSync(unitPath, 'utf8'), id);
        if (fails.length) return { status: 'refused:invalid-unit', id, path: unitPath, detail: fails.join(',') };
        const life = classifyFileLifecycle(project, unitPath, { kind: 'unit' }).classification;
        if (life === 'malformed' || life === 'read-only' || life === 'missing') return { status: `refused:unit-${life}`, id, path: unitPath };
        resumed = true;                                   // the unit landed before a crash; finish the removal
        if (life === 'no-baseline') {
          const failed = stampFailure(stamp(project, unitPath, { kind: 'unit', lastWrittenBy: 'graduate-inbox-block', now }), id, unitPath);
          if (failed) return failed;
        }
      } else {
        const fm = {};
        for (const [k, v] of Object.entries(hit.fm)) if (!INBOX_ONLY.has(k)) fm[k] = v;
        Object.assign(fm, { status: 'active', created: fm.created || now.slice(0, 10), updated: now.slice(0, 10), topics: fm.topics || '[]' }, set);
        const body = hit.body + (resolution.trim() ? `\n\n## Resolution\n\n${resolution.trim()}` : '');
        const text = `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
        const fails = schemaFails(text, id);
        if (fails.length) return { status: 'refused:invalid-unit', id, detail: fails.join(',') };
        const failed = stampFailure(create(project, unitPath, text, { kind: 'unit', lastWrittenBy: 'graduate-inbox-block', now }), id, unitPath);
        if (failed) return failed;                        // the unit's bytes landed but its baseline didn't: keep the inbox copy
      }

      // remove the block and the one blank separator line after it, by temp file + rename
      const rest = [...lines.slice(0, hit.start), ...lines.slice(hit.end)];
      if (rest[hit.start] === '') rest.splice(hit.start, 1);
      const tmp = join(project, `.inbox.md.tmp-${process.pid}-${Date.now()}`);
      try { ops.writeFileSync(tmp, rest.join('\n')); ops.renameSync(tmp, inbox); }
      catch (e) { try { ops.rmSync(tmp, { force: true }); } catch { /* reported below */ } return { status: 'pending:inbox-write-failed', id, path: unitPath, detail: e.code || e.message }; }
      return { status: resumed ? 'graduated-resumed' : 'graduated', id, path: unitPath };
    }, { retries: 20, retryDelayMs: 100, ...lockOpts });
  } catch (e) {
    if (e.code === 'LOCK_HELD') return { status: 'pending:lock-busy', id };
    if (e.code) return { status: 'pending:graduation-error', id, detail: e.code };
    throw e;
  }
}

export function main(argv) {
  const [project, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i];
  if (!project || !opt.id) { process.stderr.write('usage: graduate-inbox-block.mjs <project> --id <obs-…> [--set <json>] [--resolution-file <path>]\n'); return 2; }
  let set = {};
  if (opt.set) { try { set = JSON.parse(opt.set); } catch { process.stdout.write(JSON.stringify({ status: 'refused:bad-override', id: opt.id }) + '\n'); return 1; } }
  const resolution = opt['resolution-file'] ? readFileSync(opt['resolution-file'], 'utf8') : '';
  const r = graduateInboxBlock(project, { id: opt.id, set, resolution });
  process.stdout.write(JSON.stringify(r) + '\n');
  return r.status.startsWith('refused') ? 1 : 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
