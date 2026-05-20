/**
 * Unit store integrity checker for CORE memory architecture, per DC-77.
 *
 * Two modes (combined by default):
 *   schema    — required frontmatter fields, valid status/type values, edge target existence
 *   integrity — orphan detection, dangling edges, stale flagging, INDEX-decisions drift
 *
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * CLI:
 *   node check-units.mjs <project-path>
 *   node check-units.mjs <project-path> --mode schema
 *   node check-units.mjs <project-path> --mode integrity
 *   node check-units.mjs <project-path> --json
 *
 * Exit codes: 0 = all pass, 1 = warnings, 2 = failures, 3 = setup error.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnit, extractEdges, scoreProxyRS, parseIsoDate } from './priority.mjs';

// ---------- Schema constants ----------

export const REQUIRED_FIELDS = new Set(['id', 'type', 'status', 'created', 'updated', 'topics']);
export const VALID_STATUSES = new Set(['active', 'retired', 'archived', 'superseded']);
export const VALID_TYPES = new Set([
  'decision', 'risk', 'person', 'deliverable', 'principle',
  'explainer', 'review-finding', 'observation', 'topic', 'reference',
  'feedback', 'memory', 'open-question',
]);
export const VALID_EDGE_TYPES = new Set([
  'cites', 'supersedes', 'superseded-by', 'depends-on', 'conflicts-with',
  'references-person', 'references-topic',
  'depended-on-by', 'supersedes-claim',
]);

export const ARCHIVE_RS_THRESHOLD = 0.05;
export const STALE_DAYS = 90;

// ---------- Unit iteration ----------

export function iterActiveUnits(memoriesDir) {
  const skipDirs = new Set(['archive', 'cold-storage', '_validation']);
  const units = [];
  let entries;
  try { entries = readdirSync(memoriesDir, { withFileTypes: true }); } catch { return units; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) continue; // skip unknown sub-dirs
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name;
    if (name.startsWith('_') || name.startsWith('INDEX') || name === 'README.md') continue;
    try {
      units.push(loadUnit(join(memoriesDir, name)));
    } catch (e) {
      units.push({ path: join(memoriesDir, name), fm: {}, body: `LOAD ERROR: ${e}`, id: name.replace(/\.md$/, '') });
    }
  }
  return units;
}

export function iterAllUnitFiles(memoriesDir) {
  const paths = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '_validation') continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('INDEX') || entry.name === 'README.md') continue;
      paths.push(join(dir, entry.name));
    }
  }
  walk(memoriesDir);
  return paths;
}

// ---------- Schema checks ----------

export function checkSchema(units, memoriesDir, report) {
  const allFiles = new Set(iterAllUnitFiles(memoriesDir).map(p => basename(p, '.md')));

  for (const u of units) {
    const uid = u.fm.id !== undefined ? String(u.fm.id) : u.path ? basename(u.path, '.md') : 'unknown';
    const loadErr = typeof u.body === 'string' && u.body.startsWith('LOAD ERROR:');
    if (loadErr) { report.push({ level: 'FAIL', check: 'load', unit_id: uid, detail: `Failed to load: ${u.body}` }); continue; }

    for (const fld of REQUIRED_FIELDS) {
      if (!(fld in u.fm)) report.push({ level: 'FAIL', check: 'required-field', unit_id: uid, detail: `Missing required frontmatter field: '${fld}'` });
    }

    const status = String(u.fm.status || '').toLowerCase();
    if (status && !VALID_STATUSES.has(status))
      report.push({ level: 'WARN', check: 'status-value', unit_id: uid, detail: `Unknown status '${status}' (expected: ${[...VALID_STATUSES].sort().join(', ')})` });

    const typ = String(u.fm.type || '').toLowerCase();
    if (typ && !VALID_TYPES.has(typ))
      report.push({ level: 'WARN', check: 'type-value', unit_id: uid, detail: `Unknown type '${typ}'` });

    const topics = u.fm.topics;
    if (topics !== undefined && topics !== null && !Array.isArray(topics))
      report.push({ level: 'WARN', check: 'topics-format', unit_id: uid, detail: "Field 'topics' should be a list, found scalar" });

    const edgesRaw = u.fm.edges;
    if (Array.isArray(edgesRaw)) {
      edgesRaw.forEach((item, i) => {
        if (!item || typeof item !== 'object') { report.push({ level: 'WARN', check: 'edge-format', unit_id: uid, detail: `Edge [${i}] is not a mapping: ${JSON.stringify(item)}` }); return; }
        const eType = item.type || '';
        const eTarget = item.target || '';
        if (!eType) report.push({ level: 'WARN', check: 'edge-missing-type', unit_id: uid, detail: `Edge [${i}] missing 'type' field` });
        else if (!VALID_EDGE_TYPES.has(String(eType))) report.push({ level: 'WARN', check: 'edge-unknown-type', unit_id: uid, detail: `Edge [${i}] type '${eType}' not in committed types` });
        if (!eTarget) {
          report.push({ level: 'FAIL', check: 'edge-missing-target', unit_id: uid, detail: `Edge [${i}] (type=${JSON.stringify(eType)}) missing 'target' field` });
        } else {
          const stem = String(eTarget).replace(/\.md$/, '');
          if (!allFiles.has(stem) && !allFiles.has(String(eTarget)))
            report.push({ level: 'WARN', check: 'edge-target-missing', unit_id: uid, detail: `Edge target '${eTarget}' not found in unit store` });
        }
      });
    }

    const declaredId = u.fm.id !== undefined ? String(u.fm.id) : '';
    const stem = u.path ? basename(u.path, '.md') : '';
    if (declaredId && stem && declaredId !== stem)
      report.push({ level: 'WARN', check: 'id-mismatch', unit_id: uid, detail: `Declared id '${declaredId}' doesn't match filename stem '${stem}'` });

    report.push({ level: 'PASS', check: 'schema', unit_id: uid, detail: '' });
  }
}

// ---------- Integrity checks ----------

export function checkIntegrity(units, memoriesDir, today, report) {
  const backlinks = {};
  for (const u of units) backlinks[basename(u.path, '.md')] = new Set();
  for (const u of units) {
    for (const e of extractEdges(u)) {
      const targetStem = String(e.target).replace(/\.md$/, '');
      if (backlinks[targetStem]) backlinks[targetStem].add(basename(u.path, '.md'));
    }
  }

  for (const u of units) {
    const uid = basename(u.path, '.md');
    const edges = extractEdges(u);
    const hasOut = edges.length > 0;
    const hasIn = (backlinks[uid] || new Set()).size > 0;

    if (!hasOut && !hasIn)
      report.push({ level: 'WARN', check: 'orphan', unit_id: uid, detail: 'Unit has no edges (no outgoing, no backlinks) — consider adding a cites edge or check if it should be retired' });

    const allFiles = new Set(iterAllUnitFiles(memoriesDir).map(p => basename(p, '.md')));
    for (const e of edges) {
      const target = String(e.target);
      if (target.includes('://') || target.startsWith('http')) continue;
      const targetStem = target.replace(/\.md$/, '');
      if (!allFiles.has(targetStem) && !allFiles.has(target))
        report.push({ level: 'WARN', check: 'dangling-edge', unit_id: uid, detail: `Edge target '${target}' (type=${JSON.stringify(e.type)}) not found in unit store — external ref or missing unit?` });
    }

    const rs = scoreProxyRS(u, today);
    if (rs < ARCHIVE_RS_THRESHOLD) {
      const status = String(u.fm.status || 'active').toLowerCase();
      if (status === 'active')
        report.push({ level: 'WARN', check: 'stale', unit_id: uid, detail: `R·S=${rs.toFixed(3)} < ${ARCHIVE_RS_THRESHOLD} — archive candidate per DC-69` });
    }

    const status = String(u.fm.status || '').toLowerCase();
    if (status === 'archived' && !String(u.path).includes('archive'))
      report.push({ level: 'WARN', check: 'archived-in-active', unit_id: uid, detail: 'Unit has status=archived but is not in archive/ subdir' });
  }

  // INDEX-decisions drift
  const indexPath = join(memoriesDir, 'INDEX-decisions.md');
  try {
    const indexText = readFileSync(indexPath, 'utf8');
    const dcStems = units.filter(u => basename(u.path, '.md').startsWith('dc-')).map(u => basename(u.path, '.md'));
    const missing = dcStems.filter(stem => !indexText.includes(stem));
    if (missing.length) {
      report.push({ level: 'WARN', check: 'index-drift', unit_id: '', detail: `INDEX-decisions.md missing ${missing.length} dc-* units: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}` });
    } else {
      report.push({ level: 'PASS', check: 'index-drift', unit_id: '', detail: 'INDEX-decisions.md in sync with dc-* units' });
    }
  } catch {
    report.push({ level: 'WARN', check: 'index-missing', unit_id: '', detail: 'INDEX-decisions.md not found — run generate-decisions-index.mjs' });
  }

  // Cold-store eligibility
  const archiveDir = join(memoriesDir, 'archive');
  try {
    for (const fname of readdirSync(archiveDir)) {
      if (!fname.endsWith('.md') || fname.startsWith('_') || fname.startsWith('INDEX')) continue;
      try {
        const u = loadUnit(join(archiveDir, fname));
        const status = String(u.fm.status || '').toLowerCase();
        const lastAcc = parseIsoDate(u.fm.last_accessed || u.fm.updated || '');
        if (lastAcc) {
          const age = Math.floor((today.getTime() - lastAcc.getTime()) / 86_400_000);
          if (status === 'retired' && age > 365)
            report.push({ level: 'WARN', check: 'cold-store-eligible', unit_id: basename(fname, '.md'), detail: `Archived+retired, last_accessed ${age}d ago — cold-store candidate` });
        }
      } catch {}
    }
  } catch {}
}

// ---------- Output ----------

export function printReport(report, memoriesDir, mode, today) {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const f of report) counts[f.level] = (counts[f.level] || 0) + 1;
  console.log(`\nUnit store: ${memoriesDir}`);
  console.log(`Mode: ${mode}  |  Date: ${today.toISOString().slice(0, 10)}  |  PASS: ${counts.PASS}  WARN: ${counts.WARN}  FAIL: ${counts.FAIL}\n`);
  for (const level of ['FAIL', 'WARN']) {
    const findings = report.filter(f => f.level === level);
    if (!findings.length) continue;
    console.log(`── ${level}S ──`);
    for (const f of findings) {
      const tag = f.unit_id ? `[${f.unit_id}]  ` : '';
      console.log(`  ${f.check}: ${tag}${f.detail}`);
    }
    console.log();
  }
  const passes = report.filter(f => f.level === 'PASS' && f.detail);
  if (passes.length) {
    console.log(`── PASS (${passes.length}) ──`);
    for (const f of passes) {
      const tag = f.unit_id ? `[${f.unit_id}]  ` : '';
      console.log(`  ${f.check}: ${tag}${f.detail}`);
    }
  }
}

export function jsonReport(report, memoriesDir, mode, today) {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const f of report) counts[f.level] = (counts[f.level] || 0) + 1;
  const out = {
    memories_dir: memoriesDir,
    mode,
    date: today.toISOString().slice(0, 10),
    summary: counts,
    findings: report.filter(f => f.level !== 'PASS' || f.detail),
  };
  console.log(JSON.stringify(out, null, 2));
}

export function exitCode(report) {
  const counts = { FAIL: 0, WARN: 0 };
  for (const f of report) if (f.level === 'FAIL' || f.level === 'WARN') counts[f.level]++;
  if (counts.FAIL) return 2;
  if (counts.WARN) return 1;
  return 0;
}

// ---------- CLI ----------

export function main(argv) {
  let projectArg = '.';
  let mode = 'all';
  let asJson = false;
  let todayArg = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') { mode = argv[++i]; }
    else if (a === '--json') { asJson = true; }
    else if (a === '--today') { todayArg = argv[++i]; }
    else if (!a.startsWith('--')) { projectArg = a; }
  }

  const project = resolve(projectArg);
  let memoriesDir = join(project, '_memories');
  try { readdirSync(memoriesDir); } catch {
    memoriesDir = project;
    try { readdirSync(memoriesDir); } catch {
      process.stderr.write(`error: _memories/ not found under ${project}\n`);
      return 3;
    }
  }

  const today = todayArg ? (() => { const d = parseIsoDate(todayArg); return d || new Date(); })() : new Date();
  const report = [];
  const units = iterActiveUnits(memoriesDir);
  if (!units.length) { process.stderr.write(`error: no units found in ${memoriesDir}\n`); return 3; }

  if (mode === 'schema' || mode === 'all') checkSchema(units, memoriesDir, report);
  if (mode === 'integrity' || mode === 'all') checkIntegrity(units, memoriesDir, today, report);

  if (asJson) jsonReport(report, memoriesDir, mode, today);
  else printReport(report, memoriesDir, mode, today);

  return exitCode(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
