#!/usr/bin/env node
/**
 * dev-leakage-guard.mjs — deny-pattern scan for development leakage across the
 * ENTIRE shipped tree (marketplace installs pull the whole git repo, so every
 * file ships: plugins/**, both manifests, root docs, .github/**, and tests/**).
 *
 * Why this exists: twice in one day, David-specific content nearly shipped (or
 * briefly shipped) to every installer of this public plugin — a capability probe
 * defaulting to a personal `~/files` repo, and a personal artifact-publish waiver
 * hardcoded as the consent default with a real name in SKILL.md prose. This guard
 * is the repeatable backstop: it fails CI (and the /cut-release gate) on any hit.
 *
 * The scan is deliberately scoped per pattern (see PATTERNS[].appliesTo) so it
 * catches the dangerous surface — shipped prose, defaults, product code, personal
 * paths — without drowning in false positives from legitimate test vectors and
 * historical changelog entries. Every legitimate occurrence is either scope-
 * excluded (with a comment) or listed in ALLOWLIST with a reason.
 *
 * What this guard does NOT cover, by design (reported as judgment-call classes,
 * not auto-blocked): design-provenance code comments in *.mjs / *.json that name
 * peer agents ("Hale's finding", "per HC critique") or cite a person's decision;
 * the pervasive BBLens / T-Mobile wrapper EXAMPLE used pedagogically throughout;
 * and CHANGELOG.md's historical entries (rewriting shipped history is its own
 * decision). Those are left for a human pass. The guard targets the surfaces the
 * two real incidents lived on: user-facing prose, shipped defaults, and personal
 * filesystem/identity tokens.
 *
 * Usage:
 *   node tests/scripts/dev-leakage-guard.mjs [rootDir]   # scan; exit 1 on any hit
 * Exported for the test wrapper: scanTree, formatReport, PATTERNS, ALLOWLIST.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..'); // repo root: tests/scripts/ -> ../../

// ---- scope helpers (relPath is always forward-slashed, repo-root-relative) ----
const isMarkdown = (p) => p.endsWith('.md');
const notChangelog = (p) => p !== 'CHANGELOG.md';
const inPlugins = (p) => p.startsWith('plugins/');
const isRootDoc = (p) =>
  ['README.md', 'USAGE.md', 'INSTALL.md', 'ARCHITECTURE.md', 'llms.txt'].includes(p);
// The shipped *product* surface: plugin tree + root user docs, NOT tests/fixtures
// (which legitimately carry path vectors and personas) and NOT CHANGELOG history.
const isProductSurface = (p) => inPlugins(p) || isRootDoc(p);

// Files that ARE the scanner (they contain the deny tokens as data) — never scan.
export const SCAN_EXCLUDE = new Set([
  'tests/scripts/dev-leakage-guard.mjs',
  'tests/scripts/dev-leakage-guard.test.mjs',
]);

/**
 * Deny patterns. Each: { name, klass, re, appliesTo(relPath) }.
 * `re` is matched per line (global, so a line can yield multiple hits).
 */
export const PATTERNS = [
  // --- personal filesystem / identity tokens: block anywhere they ship ---
  {
    name: 'personal-home-username',
    klass: 'personal-path',
    // \b so the public repo owner slug `dbatesai/...` (dbates + "ai", no boundary) is NOT matched.
    re: /\bdbates\b/g,
    appliesTo: () => true,
  },
  {
    name: 'personal-name',
    klass: 'personal-identity',
    // "David Bates" / "David.Bates" (incl. the corporate-username variant David.Bates28).
    re: /David[.\s]Bates/g,
    appliesTo: () => true,
  },
  {
    name: 'personal-files-repo',
    klass: 'personal-env',
    re: /~\/files\b/g,
    appliesTo: () => true,
  },
  {
    name: 'personal-acceptance-dir',
    klass: 'personal-env',
    re: /core-acceptance/g,
    appliesTo: () => true,
  },
  {
    name: 'personal-repo-files',
    klass: 'personal-repo',
    re: /dbatesai\/files\b/g,
    appliesTo: () => true,
  },
  {
    name: 'machine-name-jennifer',
    klass: 'machine-name',
    re: /Jennifer-Aniston/gi,
    appliesTo: () => true,
  },
  {
    name: 'machine-name-r11',
    klass: 'machine-name',
    re: /\bR11\b/g,
    // Historical changelog entries name the box; rewriting history is out of scope.
    appliesTo: (p) => notChangelog(p),
  },
  {
    name: 'ntfy-channel',
    klass: 'notification-channel',
    re: /brine-wren-cedar-axiom-inlet-grove/g,
    appliesTo: () => true,
  },
  // --- absolute personal path in the shipped product surface (any username) ---
  {
    name: 'abs-user-path-in-product',
    klass: 'personal-path',
    re: /\/Users\/[A-Za-z][A-Za-z0-9._-]*/g,
    appliesTo: (p) => isProductSurface(p),
  },
  // --- agent names hardcoded in shipped PROSE (.md): only product names ship ---
  {
    name: 'agent-name-in-prose',
    klass: 'agent-name',
    re: /\b(Keel|Hale|Antigravity|Crest|Meridian|Tideline)\b/g,
    appliesTo: (p) => isMarkdown(p) && notChangelog(p),
  },
  // --- a specific person's name in shipped prose (identity + authorization) ---
  {
    name: 'person-in-prose',
    klass: 'personal-identity',
    re: /\bDavid\b/g,
    appliesTo: (p) => isMarkdown(p) && notChangelog(p),
  },
];

/**
 * Allowlist: legitimate occurrences, each with a reason. A finding is suppressed
 * when an entry matches its file (or dirPrefix) AND its pattern name.
 * Keep this TIGHT — every entry earns its place.
 */
export const ALLOWLIST = [
  // Repo owner / copyright fields — the plugin's genuine identity, not a leak.
  { file: '.claude-plugin/marketplace.json', patterns: ['personal-name'], reason: 'marketplace owner field — legitimate author identity' },
  { file: 'plugins/core/.claude-plugin/plugin.json', patterns: ['personal-name'], reason: 'plugin.json author field — legitimate author identity' },
  { file: 'plugins/core/.codex-plugin/plugin.json', patterns: ['personal-name'], reason: 'codex plugin.json author/developer fields — legitimate author identity' },
  { file: 'LICENSE', patterns: ['personal-name'], reason: 'MIT copyright holder — legitimate' },
  { file: 'plugins/core/LICENSE', patterns: ['personal-name'], reason: 'MIT copyright holder — legitimate' },

  // Historical changelog entry describing the dotted-username slug-encoding bug
  // (test username, technical note). Rewriting shipped history is out of scope.
  { file: 'CHANGELOG.md', patterns: ['personal-name'], reason: 'historical changelog technical note (dotted-username bug)' },

  // Path→slug / plugin-root / transcript mapping tests: these EXIST to prove the
  // username-generalization logic. Real-looking usernames are the test vectors.
  { file: 'tests/scripts/project-slug.test.mjs', patterns: ['personal-home-username', 'personal-name'], reason: 'path→slug encoding test vectors (dbates, David.Bates28)' },
  { file: 'tests/scripts/resolve-plugin-root.test.mjs', patterns: ['personal-home-username'], reason: 'plugin-root authority-classification test vectors' },
  { file: 'tests/scripts/read-transcript.test.mjs', patterns: ['personal-home-username', 'personal-name'], reason: 'transcript-path slug test vectors' },
  { file: 'tests/scripts/auto-memory-injection-probe.test.mjs', patterns: ['personal-home-username', 'personal-name'], reason: 'mapped-memory-path test vectors' },
  { file: 'tests/scripts/audit-memory-boundary.test.mjs', patterns: ['personal-name'], reason: 'mapped-native-path test vector (David.Bates28)' },
  { file: 'tests/scripts/aggregate-receipt.test.mjs', patterns: ['personal-home-username'], reason: 'refusal-scan test inputs — asserts these paths get redacted' },

  // Retrieval-test persona store: "David" is the user persona in a throwaway
  // watch-buying fixture store. Not shipped behavioral prose. (Judgment call —
  // flagged for a human on whether to rename the persona.)
  { dirPrefix: 'tests/fixtures/obligation3-store/', patterns: ['person-in-prose'], reason: 'retrieval-test user persona in fixture unit bodies' },
];

function isAllowed(relPath, patternName) {
  return ALLOWLIST.some(
    (e) =>
      (e.file === relPath || (e.dirPrefix && relPath.startsWith(e.dirPrefix))) &&
      (e.patterns === '*' || e.patterns.includes(patternName)),
  );
}

// ---- filesystem walk ----
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov)$/i;

function walk(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, abs, out);
    } else if (entry.isFile()) {
      const rel = relative(root, abs).split('\\').join('/');
      if (SCAN_EXCLUDE.has(rel)) continue;
      if (BINARY_EXT.test(entry.name)) continue;
      out.push({ abs, rel });
    }
  }
}

/**
 * The shipped file set. In a git working tree that means the TRACKED files only
 * (untracked local cruft never ships, so it must never trip the guard). For a
 * `git archive` extraction (the /cut-release case — no .git present), fall back
 * to a filesystem walk, where everything present is by definition shipped.
 */
function listShippedFiles(root) {
  if (existsSync(join(root, '.git'))) {
    try {
      const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
      return out
        .split('\0')
        .filter(Boolean)
        .map((rel) => ({ abs: join(root, rel), rel }))
        .filter(({ rel }) => !SCAN_EXCLUDE.has(rel) && !BINARY_EXT.test(rel));
    } catch {
      /* fall through to walk */
    }
  }
  const out = [];
  walk(root, root, out);
  return out;
}

/**
 * Scan a tree. Returns an array of findings:
 *   { file, line, klass, pattern, match, text }
 * @param {{root?: string, files?: {abs,rel}[]}} opts
 */
export function scanTree(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const files = opts.files || listShippedFiles(root);
  const findings = [];
  for (const { abs, rel } of files) {
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue; // binary
    const active = PATTERNS.filter((p) => p.appliesTo(rel));
    if (active.length === 0) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      for (const p of active) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text)) !== null) {
          if (isAllowed(rel, p.name)) break; // whole (file,pattern) is allowlisted
          findings.push({
            file: rel,
            line: i + 1,
            klass: p.klass,
            pattern: p.name,
            match: m[0],
            text: text.trim().slice(0, 200),
          });
          if (m.index === p.re.lastIndex) p.re.lastIndex++; // zero-width guard
        }
      }
    }
  }
  return findings;
}

export function formatReport(findings) {
  if (findings.length === 0) return 'dev-leakage-guard: clean — no development leakage found.';
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const out = [`dev-leakage-guard: ${findings.length} finding(s) across ${byFile.size} file(s):`, ''];
  for (const [file, list] of byFile) {
    out.push(file);
    for (const f of list) {
      out.push(`  :${f.line}  [${f.klass}/${f.pattern}]  "${f.match}"  — ${f.text}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] || DEFAULT_ROOT;
  const findings = scanTree({ root });
  process.stdout.write(formatReport(findings) + '\n');
  process.exit(findings.length > 0 ? 1 : 0);
}
