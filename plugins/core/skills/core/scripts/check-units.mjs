/**
 * Unit store integrity checker for CORE memory architecture, per DC-77.
 *
 * Two modes (combined by default):
 *   schema    — frontmatter shape: required fields, valid status/type/edge-type
 *               values, well-formed edge mappings, id-vs-filename match
 *   integrity — structural relationships: orphans, dangling edge targets,
 *               staleness, archived-in-active, INDEX-decisions drift,
 *               cold-store eligibility
 *
 * The two modes are deliberately non-overlapping. Schema validates each unit
 * in isolation; integrity validates the graph. Edge-target existence is an
 * integrity concern (dangling-edge); schema only checks the edge mapping is
 * well-formed and the type is in VALID_EDGE_TYPES.
 *
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * CLI:
 *   node check-units.mjs <project-path>
 *   node check-units.mjs --store <project-path>
 *   node check-units.mjs <project-path> --mode schema
 *   node check-units.mjs <project-path> --schema           (shorthand)
 *   node check-units.mjs <project-path> --mode integrity
 *   node check-units.mjs <project-path> --integrity        (shorthand)
 *   node check-units.mjs <project-path> --json
 *   node check-units.mjs <project-path> --include-observations
 *       (full-store audit incl. observations/ — used by /process-memory)
 *
 * Exit codes: 0 = all pass, 1 = non-benign warnings, 2 = failures, 3 = setup error.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnit, extractEdges, scoreProxyRS, parseIsoDate } from './priority.mjs';

// ---------- Schema constants ----------

export const REQUIRED_FIELDS = new Set(['id', 'type', 'status', 'created', 'updated', 'topics']);

// Vocabulary constants live in unit-vocab.mjs (SYN-005 unification) and are
// re-exported here so every existing importer and test keeps working.
export {
  VALID_STATUSES, TERMINAL_STATUSES, VALID_TYPES, VALID_EDGE_TYPES,
  EDGE_TYPE_NORMALIZE, VALID_CONFIDENCE_LEVELS, VALID_STABILITY_CLASSES,
} from './unit-vocab.mjs';
import {
  VALID_STATUSES, VALID_TYPES, VALID_EDGE_TYPES, EDGE_TYPE_NORMALIZE,
  VALID_CONFIDENCE_LEVELS, VALID_STABILITY_CLASSES,
} from './unit-vocab.mjs';

// Edge targets that legitimately live OUTSIDE the project unit store. The integrity
// walk would otherwise flag these as dangling (see obs-validator-cross-store-blindness):
//   1. cross-store units by naming convention — feedback_/project_/reference_ live in
//      the harness auto-memory or cross-project memory, never in <project>/_memories/.
//   2. citations and file paths — research papers ("Park et al. (arxiv…)"), doc paths
//      (docs/specs/…), stale mirror paths — never unit IDs (they carry whitespace,
//      parentheses, or a path separator a kebab-case unit id can't).
// Recognized refs are reported as a benign 'external-ref', not 'dangling-edge', so a
// genuine broken unit reference stands out instead of hiding in the cross-store noise.
export const KNOWN_EXTERNAL_PREFIXES = [
  'feedback_', 'feedback-', 'project_', 'project-', 'reference_', 'reference-',
];
export function isExternalRef(target) {
  const t = String(target).replace(/\.md$/, '');
  if (KNOWN_EXTERNAL_PREFIXES.some(p => t.startsWith(p))) return true;
  if (/[\s()]/.test(t) || t.includes('/')) return true; // citation or file path, not a unit id
  return false;
}

export const ARCHIVE_RS_THRESHOLD = 0.05;
export const STALE_DAYS = 90;
export const SOURCES_WARN_AGE_DAYS = 14;

// MEM-014: PROJECT.md and the hot section are capped, but a single unit had no
// size signal anywhere — retrieval reads matched units whole, so one bloated
// unit eats disproportionate context. ~10KB ≈ 3K tokens at the 0.30 factor.
export const UNIT_SIZE_WARN_BYTES = 10_000;

// ---------- Unit iteration ----------

// Generated render artifacts use the `_` filename prefix (e.g. `_capability-drift-log.md`),
// which the `name.startsWith('_')` skip below already exempts from schema and integrity
// validation. No separate producer/path map is needed.

export function iterActiveUnits(memoriesDir, { includeObservations = false } = {}) {
  const units = [];
  let entries;
  try { entries = readdirSync(memoriesDir, { withFileTypes: true }); } catch { return units; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Top-level only by design: archive/, cold-storage/, _validation/, observations/
    // and every other sub-dir are out of the active set. (The old skipDirs allow-list
    // was dead — both branches skipped, so all sub-dirs are skipped regardless.)
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name;
    if (name.startsWith('_') || name.startsWith('INDEX') || name === 'README.md') continue;
    try {
      const u = loadUnit(join(memoriesDir, name));
      units.push(u);
    } catch (e) {
      units.push({ path: join(memoriesDir, name), fm: {}, body: `LOAD ERROR: ${e}`, id: name.replace(/\.md$/, '') });
    }
  }

  if (includeObservations) {
    // SYN-007: observation units live in observations/<YYYY-MM>/ and were never
    // schema-audited, even though iterAllUnitFiles (the dangling-edge target
    // set) is recursive — edges could point at observations that pass the
    // dangling check but escape every other check. Opt-in keeps the default
    // active set top-level-only.
    const obsPaths = iterAllUnitFiles(join(memoriesDir, 'observations')).sort();
    for (const p of obsPaths) {
      try { units.push(loadUnit(p)); }
      catch (e) { units.push({ path: p, fm: {}, body: `LOAD ERROR: ${e}`, id: basename(p, '.md') }); }
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
  for (const u of units) {
    const uid = u.fm.id !== undefined ? String(u.fm.id) : u.path ? basename(u.path, '.md') : 'unknown';
    const loadErr = typeof u.body === 'string' && u.body.startsWith('LOAD ERROR:');
    if (loadErr) { report.push({ level: 'FAIL', check: 'load', unit_id: uid, detail: `Failed to load: ${u.body}` }); continue; }

    for (const fld of REQUIRED_FIELDS) {
      if (!(fld in u.fm)) report.push({ level: 'FAIL', check: 'required-field', unit_id: uid, detail: `Missing required frontmatter field: '${fld}'` });
    }

    // MEM-008: a key that is PRESENT but blank passed both the presence check
    // (key in fm) and the value checks (guarded by truthiness). `type: `
    // parses to an empty list; '' and null are the scalar variants.
    for (const fld of ['id', 'type', 'status', 'created', 'updated']) {
      if (!(fld in u.fm)) continue; // absence already FAILed above
      const v = u.fm[fld];
      const blank = v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
      if (blank) report.push({ level: 'FAIL', check: 'required-field-empty', unit_id: uid, detail: `Required field '${fld}' is present but empty` });
    }

    const status = String(u.fm.status || '').toLowerCase();
    if (status && !VALID_STATUSES.has(status))
      report.push({ level: 'WARN', check: 'status-value', unit_id: uid, detail: `Unknown status '${status}' (expected: ${[...VALID_STATUSES].sort().join(', ')})` });

    const typ = String(u.fm.type || '').toLowerCase();
    if (typ && !VALID_TYPES.has(typ))
      report.push({ level: 'WARN', check: 'type-value', unit_id: uid, detail: `Unknown type '${typ}'` });

    // confidence-level / stability-class — typed by the source-registration
    // framework but previously unvalidated: a unit could carry
    // confidence-level: banana and pass everything (SYN-005 / SCH-003).
    const conf = String(u.fm['confidence-level'] || '').toLowerCase();
    if (conf && !VALID_CONFIDENCE_LEVELS.has(conf))
      report.push({ level: 'WARN', check: 'confidence-level-value', unit_id: uid, detail: `Unknown confidence-level '${conf}' (expected: ${[...VALID_CONFIDENCE_LEVELS].sort().join(', ')})` });
    for (const scField of ['stability-class', 'proposed-stability-class']) {
      const sc = String(u.fm[scField] || '').toLowerCase();
      if (sc && !VALID_STABILITY_CLASSES.has(sc))
        report.push({ level: 'WARN', check: 'stability-class-value', unit_id: uid, detail: `Unknown ${scField} '${sc}' (expected: ${[...VALID_STABILITY_CLASSES].sort().join(', ')})` });
    }

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
        else if (!VALID_EDGE_TYPES.has(String(eType))) {
          const norm = EDGE_TYPE_NORMALIZE[String(eType)];
          report.push({ level: 'WARN', check: 'edge-unknown-type', unit_id: uid, detail: norm
            ? `Edge [${i}] type '${eType}' not in committed types — normalize to '${norm}' (safe-fix)`
            : `Edge [${i}] type '${eType}' not in committed types — relabel to a committed type or surface for a bless decision` });
        }
        if (!eTarget) {
          report.push({ level: 'FAIL', check: 'edge-missing-target', unit_id: uid, detail: `Edge [${i}] (type=${JSON.stringify(eType)}) missing 'target' field` });
        }
        // Edge target existence is an integrity concern, not schema — see
        // checkIntegrity for dangling-edge. Schema only validates the edge
        // mapping is well-formed and has a type in VALID_EDGE_TYPES.
      });
    }

    const declaredId = u.fm.id !== undefined ? String(u.fm.id) : '';
    const stem = u.path ? basename(u.path, '.md') : '';
    if (declaredId && stem && declaredId !== stem)
      report.push({ level: 'WARN', check: 'id-mismatch', unit_id: uid, detail: `Declared id '${declaredId}' doesn't match filename stem '${stem}'` });

    // Validity-dimension fields (t_valid/t_invalid) — optional on any unit,
    // validated here beside every other frontmatter field.
    // Schema only validates well-formedness: ISO dates, and t_valid <= t_invalid.
    // Semantics + population live in bitemporal.mjs; the created-default is
    // computed at read-time, so absence is normal and never flagged.
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    const tValidRaw = u.fm.t_valid;
    const tInvalidRaw = u.fm.t_invalid;
    const fmtOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
    let tValidStr = null, tInvalidStr = null;
    if (tValidRaw !== undefined && tValidRaw !== null && tValidRaw !== '') {
      tValidStr = fmtOf(tValidRaw);
      if (!isoRe.test(tValidStr)) report.push({ level: 'WARN', check: 't_valid-format', unit_id: uid, detail: `Field 't_valid' must be ISO date (YYYY-MM-DD), found '${tValidStr}'` });
    }
    if (tInvalidRaw !== undefined && tInvalidRaw !== null && tInvalidRaw !== '') {
      tInvalidStr = fmtOf(tInvalidRaw);
      if (!isoRe.test(tInvalidStr)) report.push({ level: 'WARN', check: 't_invalid-format', unit_id: uid, detail: `Field 't_invalid' must be ISO date (YYYY-MM-DD), found '${tInvalidStr}'` });
    }
    if (tValidStr && tInvalidStr && isoRe.test(tValidStr) && isoRe.test(tInvalidStr) && tValidStr > tInvalidStr)
      report.push({ level: 'WARN', check: 't_valid-after-t_invalid', unit_id: uid, detail: `t_valid (${tValidStr}) is after t_invalid (${tInvalidStr}) — a fact can't stop being true before it started` });

    // by-when validation — optional field for open-question units (DC-85 §2).
    // Schema only validates well-formedness; staleness signaling lives in the startup protocol.
    const byWhen = u.fm['by-when'];
    if (byWhen !== undefined && byWhen !== null && byWhen !== '') {
      if (typ && typ !== 'open-question')
        report.push({ level: 'WARN', check: 'by-when-on-wrong-type', unit_id: uid, detail: `Field 'by-when' is only meaningful on type:open-question, found on type:${typ}` });
      const byWhenStr = byWhen instanceof Date ? byWhen.toISOString().slice(0, 10) : String(byWhen).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(byWhenStr))
        report.push({ level: 'WARN', check: 'by-when-format', unit_id: uid, detail: `Field 'by-when' must be ISO date (YYYY-MM-DD), found '${byWhenStr}'` });
    }

    // MEM-014 advisory size check.
    let unitBytes = 0;
    try { unitBytes = statSync(u.path).size; }
    catch { unitBytes = Buffer.byteLength(String(u.body || ''), 'utf8'); }
    if (unitBytes > UNIT_SIZE_WARN_BYTES)
      report.push({ level: 'WARN', check: 'unit-oversize', unit_id: uid, detail: `Unit is ${unitBytes} bytes (> ${UNIT_SIZE_WARN_BYTES}) — split or compact; retrieval reads matched units whole` });

    report.push({ level: 'PASS', check: 'schema', unit_id: uid, detail: '' });
  }
}

// ---------- Integrity checks ----------

export const FRESH_STORE_ORPHAN_RATIO = 0.30;

export function checkIntegrity(units, memoriesDir, today, report) {
  const backlinks = {};
  for (const u of units) backlinks[basename(u.path, '.md')] = new Set();
  for (const u of units) {
    for (const e of extractEdges(u)) {
      const targetStem = String(e.target).replace(/\.md$/, '');
      if (backlinks[targetStem]) backlinks[targetStem].add(basename(u.path, '.md'));
    }
  }

  // Build the all-files set once (was rebuilt per-unit inside the loop).
  const allFiles = new Set(iterAllUnitFiles(memoriesDir).map(p => basename(p, '.md')));
  let orphanCount = 0;

  for (const u of units) {
    const uid = basename(u.path, '.md');
    const edges = extractEdges(u);
    const hasOut = edges.length > 0;
    const hasIn = (backlinks[uid] || new Set()).size > 0;

    if (!hasOut && !hasIn) {
      orphanCount += 1;
      report.push({ level: 'WARN', check: 'orphan', unit_id: uid, detail: 'Unit has no edges (no outgoing, no backlinks) — consider adding a cites edge or check if it should be retired' });
    }

    for (const e of edges) {
      const target = String(e.target);
      if (target.includes('://') || target.startsWith('http')) continue;
      // references-topic edges target the controlled vocabulary (~/.core/topics.md),
      // not unit IDs. Validating them against the unit store produced false
      // dangling-edge warnings; a correctly-typed references-topic edge is an
      // external vocab reference and is always valid here.
      if (e.type === 'references-topic') continue;
      const targetStem = target.replace(/\.md$/, '');
      if (!allFiles.has(targetStem) && !allFiles.has(target)) {
        if (isExternalRef(target)) {
          report.push({ level: 'WARN', check: 'external-ref', unit_id: uid, detail: `Edge target '${target}' (type=${JSON.stringify(e.type)}) is a recognized cross-store/external reference (not in the project unit store) — expected, not a break.` });
        } else {
          report.push({ level: 'WARN', check: 'dangling-edge', unit_id: uid, detail: `Edge target '${target}' (type=${JSON.stringify(e.type)}) not found in unit store — external ref or missing unit?` });
        }
      }
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

    // MEM-018: unknown provenance is now visible. An active, aged,
    // non-observation unit with no sources scores the degraded S default —
    // surface it so a sources entry gets added. Advisory (benign).
    const srcVal = u.fm.sources;
    const noSources = srcVal === undefined || srcVal === null || (Array.isArray(srcVal) && srcVal.length === 0);
    const typLower = String(u.fm.type || '').toLowerCase();
    if (noSources && typLower !== 'observation' && String(u.fm.status || 'active').toLowerCase() === 'active') {
      const created = parseIsoDate(u.fm.created);
      const srcAge = created ? Math.floor((today.getTime() - created.getTime()) / 86_400_000) : null;
      if (srcAge !== null && srcAge > SOURCES_WARN_AGE_DAYS)
        report.push({ level: 'WARN', check: 'sources-missing', unit_id: uid, detail: `Active ${typLower || 'unit'} ${srcAge}d old with no sources — unknown provenance scores S=0.3; add a sources entry` });
    } else if (typeof srcVal === 'string' && srcVal.trim() !== '') {
      // Scalar `sources: PROJECT.md` works (priority.mjs coerces it), but the
      // list form is the documented shape — nudge toward it. Advisory (benign).
      report.push({ level: 'WARN', check: 'sources-not-list', unit_id: uid, detail: `sources is a scalar string ('${srcVal}') — use list form (sources:\\n  - ${srcVal}) so the field reads as a list everywhere` });
    }
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

  // Fresh-store hint: if many units are orphans, it's usually a freshly-
  // migrated store where edges haven't accrued yet, not a real problem.
  if (units.length > 0 && orphanCount / units.length >= FRESH_STORE_ORPHAN_RATIO) {
    const pct = Math.round((orphanCount / units.length) * 100);
    report.push({ level: 'INFO', check: 'fresh-store', unit_id: '', detail: `${orphanCount}/${units.length} units (${pct}%) are orphans — this often means a freshly-migrated store; edges accrue as units cite each other during use.` });
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
  const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const f of report) counts[f.level] = (counts[f.level] || 0) + 1;
  console.log(`\nUnit store: ${memoriesDir}`);
  console.log(`Mode: ${mode}  |  Date: ${today.toISOString().slice(0, 10)}  |  PASS: ${counts.PASS}  WARN: ${counts.WARN}  FAIL: ${counts.FAIL}\n`);

  const infos = report.filter(f => f.level === 'INFO');
  if (infos.length) {
    console.log('── NOTES ──');
    for (const f of infos) console.log(`  ${f.check}: ${f.detail}`);
    console.log();
  }

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
  const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
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

// Warnings that are normal/expected and must NOT block startup or automation —
// especially on a fresh or freshly-migrated store, where a high orphan count is
// expected (edges accrue as units cite each other). topics-format is benign too
// (and largely eliminated by flow-style array parsing). These return exit 0.
export const BENIGN_WARN_CHECKS = new Set([
  'orphan', 'stale', 'fresh-store', 'cold-store-eligible', 'topics-format',
  'external-ref', 'sources-missing', 'sources-not-list', 'unit-oversize',
  // Legacy annotations predate the source-registration-framework vocab; visibility without degradation (SYN-005 follow-up).
  'confidence-level-value', 'stability-class-value',
]);

// Exit-code contract: 0 = pass (including pass-with-benign-warnings),
// 1 = degraded (non-benign warnings worth surfacing, still non-blocking),
// 2 = hard fail (schema/enum/required-field/broken edge). A healthy store with
// only orphan/stale warnings exits 0 so it can't block a startup gate.
export function exitCode(report) {
  let hasFail = false, hasDegradedWarn = false;
  for (const f of report) {
    if (f.level === 'FAIL') hasFail = true;
    else if (f.level === 'WARN' && !BENIGN_WARN_CHECKS.has(f.check)) hasDegradedWarn = true;
  }
  if (hasFail) return 2;
  if (hasDegradedWarn) return 1;
  return 0;
}

// ---------- CLI ----------

/**
 * Resolve which checks to run from the mode flags. ADDITIVE: `--schema` and
 * `--integrity` (or two `--mode` flags) each turn ON their check rather than
 * overwriting a single `mode`, so `--schema --integrity` runs BOTH. The old
 * last-wins parser silently dropped the schema half of exactly that invocation
 * (the disjoint-surface gap /finalize hit). No mode flag at all = both (default).
 * @returns {{schema: boolean, integrity: boolean, mode: string}}
 */
export function resolveChecks(argv) {
  let schema = false, integrity = false, explicit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      const mv = argv[++i];
      if (mv === 'schema') schema = true;
      else if (mv === 'integrity') integrity = true;
      else { schema = true; integrity = true; } // 'all' or anything unrecognized
      explicit = true;
    } else if (a === '--schema') { schema = true; explicit = true; }
    else if (a === '--integrity') { integrity = true; explicit = true; }
  }
  if (!explicit) { schema = true; integrity = true; }
  const mode = schema && integrity ? 'all' : (schema ? 'schema' : 'integrity');
  return { schema, integrity, mode };
}

export function main(argv) {
  let projectArg = '.';
  let asJson = false;
  let todayArg = null;
  let includeObservations = false;
  const { schema: doSchema, integrity: doIntegrity, mode } = resolveChecks(argv);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') { i++; }                              // value handled by resolveChecks
    else if (a === '--schema' || a === '--integrity') { /* handled by resolveChecks */ }
    else if (a === '--store') { projectArg = argv[++i]; }
    else if (a === '--json') { asJson = true; }
    else if (a === '--today') { todayArg = argv[++i]; }
    else if (a === '--include-observations') { includeObservations = true; }
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
  const units = iterActiveUnits(memoriesDir, { includeObservations });
  if (!units.length) { process.stderr.write(`error: no units found in ${memoriesDir}\n`); return 3; }

  if (doSchema) checkSchema(units, memoriesDir, report);
  if (doIntegrity) checkIntegrity(units, memoriesDir, today, report);

  if (asJson) jsonReport(report, memoriesDir, mode, today);
  else printReport(report, memoriesDir, mode, today);

  return exitCode(report);
}

// CLI entry guard. Set CORE_DEBUG_CLI_ENTRY=1 to log both strings if invocation
// silently no-ops (path-normalization, symlinks, OneDrive virtualization, etc.).
const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
