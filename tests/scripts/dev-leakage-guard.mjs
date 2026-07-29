#!/usr/bin/env node
/**
 * dev-leakage-guard.mjs — deny-pattern scan for development leakage.
 *
 * The contract: a marketplace install pulls the whole public repository, so no
 * tracked file — shipped prose, product code, tests, and the changelog alike —
 * may carry personal identity tokens, personal filesystem paths, machine
 * names, notification channels, internal agent names, or internal
 * development-process references (issue ids, review lineage, review-batch
 * labels), with ONE exception the scan cannot cover: this scanner
 * implementation itself, whose PATTERNS hold the literal deny tokens as
 * machine data (see SCAN_EXCLUDE below). Every other legitimate occurrence is
 * listed in ALLOWLIST with a reason; the allowlist stays narrow: author/
 * license identity fields and deliberate scanner/test fixtures only. This
 * guard fails CI (and the /cut-release gate) on any hit.
 *
 * Not covered, by design: the BBLens / T-Mobile wrapper EXAMPLE used
 * pedagogically throughout is product-chosen example content, not leakage.
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
const inPlugins = (p) => p.startsWith('plugins/');
const isRootDoc = (p) =>
  ['README.md', 'USAGE.md', 'INSTALL.md', 'ARCHITECTURE.md', 'llms.txt'].includes(p);
// The shipped *product* surface: plugin tree + root user docs, NOT tests/fixtures
// (which legitimately carry path vectors and personas) and NOT CHANGELOG history.
const isProductSurface = (p) => inPlugins(p) || isRootDoc(p);

// The ONE file the scan cannot cover: this scanner implementation, whose
// PATTERNS hold the literal deny tokens as machine data — scanning it can only
// ever false-positive on its own pattern definitions. That limitation is
// stated here instead of claiming whole-tree coverage. The guard's TEST file
// is NOT excluded: its planted tokens are fragment-constructed at runtime, so
// it is scanned like any other tracked file (a blanket self-exclusion was a
// blind spot exactly where leaks get pasted).
export const SCAN_EXCLUDE = new Set([
  'tests/scripts/dev-leakage-guard.mjs',
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
    appliesTo: () => true,
  },
  {
    name: 'ntfy-channel',
    klass: 'notification-channel',
    re: /brine-wren-cedar-axiom-inlet-grove/g,
    appliesTo: () => true,
  },
  // --- personal email, any form, whole tree ---
  {
    name: 'personal-email',
    klass: 'personal-identity',
    re: /david[._-]?bates\d*@[a-z0-9.-]+/gi,
    appliesTo: () => true,
  },
  // --- absolute personal path in the shipped product surface (any username) ---
  {
    name: 'abs-user-path-in-product',
    klass: 'personal-path',
    re: /\/Users\/[A-Za-z][A-Za-z0-9._-]*/g,
    appliesTo: (p) => isProductSurface(p),
  },
  // --- internal agent names, hardcoded anywhere in tracked text: only product
  // names ship. Case-insensitive with ALPHANUMERIC boundaries: \b treats _ as
  // a word char, so a slug like reference_keel_handoff_channels slipped a
  // \b-bounded case-sensitive match. Letters guard the flanks (inhale/shale
  // never match; per-agy-review and _keel_ do). ---
  {
    name: 'agent-name-in-prose',
    klass: 'agent-name',
    re: /(?<![A-Za-z0-9])(?:keel|hale|agy|antigravity|crest|meridian|tideline)(?![A-Za-z0-9])/gi,
    appliesTo: () => true,
  },
  // --- a specific person's name anywhere in tracked text ---
  {
    name: 'person-in-prose',
    klass: 'personal-identity',
    re: /\bDavid\b/g,
    appliesTo: () => true,
  },
  // --- internal decision-ledger references (DC-XX) anywhere in tracked text ---
  {
    name: 'dc-reference',
    klass: 'dev-process',
    // [a-z]? covers letter-suffixed refs (DC-94a); case-insensitive because
    // bare lowercase refs (dc-127) leak identically. The (?!-) carve-out
    // exempts slug-continued ids (dc-12-routing-rewrite): `dc-<n>-<slug>` is
    // the PRODUCT's own decision-unit naming convention, and schema docs
    // legitimately show fictional examples of it. A slugged ref to an
    // internal workshop unit is mechanically indistinguishable from such an
    // example — that residual class is a hand-review item, not a guard item.
    re: /\b[Dd][Cc]-\d+[a-z]?\b(?!-)/g,
    appliesTo: () => true,
  },
  // --- internal development-process forms: issue ids, review-turn lineage,
  // dead internal sentinels, named acceptance labels ---
  {
    name: 'internal-issue-id',
    klass: 'dev-process',
    // AUD-3 / HC_539 / SL-3 / MET-004 / SYN-2 / MEM-1 / SOD-4 / JC-2 /
    // HARNESS-1 / PROTO-2 — the internal issue-prefix vocabulary. Digit
    // required, so prose words and file names never match.
    re: /\b(?:AUD-\d+[a-z]?|HC_\d+|(?:SL|MET|SYN|MEM|SOD|JC|HARNESS|PROTO)-\d+)\b/g,
    appliesTo: () => true,
  },
  {
    name: 'review-turn-lineage',
    klass: 'dev-process',
    // "RM Turn 14" / "RC Turn evt-c97d" review-session lineage, and the
    // dead internal sentinel value.
    re: /\b(?:RM|RC) Turn\b|pending-hc-spec/g,
    appliesTo: () => true,
  },
  {
    name: 'named-acceptance-label',
    klass: 'dev-process',
    // "ACCEPTANCE Hale-ea140b0 item 3"-style labels tying tests to a named
    // reviewer's fix list.
    re: /ACCEPTANCE\s+(?:Keel|Hale|Agy|Antigravity|Crest|Meridian)[-\s]/g,
    appliesTo: () => true,
  },
  // --- internal review-batch labels: strong families are unambiguous ---
  {
    name: 'internal-review-label',
    klass: 'dev-process',
    re: /(?<![A-Za-z0-9])(?:FM-\d+|blocker-\d+|Train [A-Z]|Gate [A-Z]|Slice [A-Z]|HOOK-\d+|RC-\d+|ID-\d+)(?![A-Za-z0-9])/g,
    appliesTo: () => true,
  },
  // --- bare single-letter review-batch labels (M14, K17, A5, D1, G2, F9,
  // P3, B6a). Legitimate domain data exists in this shape, so exemptions are
  // EXACT files with a semantic reason — never a directory or the family. ---
  {
    name: 'internal-review-label-bare',
    klass: 'dev-process',
    re: /(?<![A-Za-z0-9])[MKADGFPB]\d{1,2}[a-z]?(?![A-Za-z0-9])/g,
    appliesTo: () => true,
  },
  // --- names in shipped JSON config/schema files: configs are product
  // surface — a name in a schema default or manifest description ships to
  // every install. Owner/author fields in the manifests are allowlisted;
  // nothing else earns a name.
  {
    name: 'name-in-json-config',
    klass: 'personal-identity',
    re: /(?<![A-Za-z0-9])(?:keel|hale|agy|antigravity|crest|meridian|tideline|david)(?![A-Za-z0-9])/gi,
    appliesTo: (p) => p.endsWith('.json'),
  },
];

/**
 * Allowlist: legitimate occurrences, each with a reason. A finding is suppressed
 * when an entry matches its file (or dirPrefix) AND its pattern name.
 * Keep this TIGHT — every entry earns its place.
 */
export const ALLOWLIST = [
  // Repo owner / copyright fields — the plugin's genuine identity, not a leak.
  // Author name + email in the manifests are deliberate public authorship
  // metadata (npm-convention author fields), not accidental leakage.
  { file: '.claude-plugin/marketplace.json', patterns: ['personal-name', 'person-in-prose', 'name-in-json-config', 'personal-email'], reason: 'marketplace owner field — legitimate author identity (name + email are deliberate authorship metadata)' },
  { file: 'plugins/core/.claude-plugin/plugin.json', patterns: ['personal-name', 'person-in-prose', 'name-in-json-config', 'personal-email'], reason: 'plugin.json author field — legitimate author identity (name + email are deliberate authorship metadata)' },
  { file: 'plugins/core/.codex-plugin/plugin.json', patterns: ['personal-name', 'person-in-prose', 'name-in-json-config', 'personal-email'], reason: 'codex plugin.json author/developer fields — legitimate author identity (name + email are deliberate authorship metadata)' },
  { file: 'LICENSE', patterns: ['personal-name', 'person-in-prose'], reason: 'MIT copyright holder — legitimate' },
  { file: 'plugins/core/LICENSE', patterns: ['personal-name', 'person-in-prose'], reason: 'MIT copyright holder — legitimate' },

  // Historical changelog entry describing the dotted-username slug-encoding bug
  // (test username, technical note). Rewriting shipped history is out of scope.
  { file: 'CHANGELOG.md', patterns: ['personal-name', 'person-in-prose'], reason: 'historical changelog technical note (dotted-username bug test vector)' },

  // P2/P3 here name the retrieval-policy tiers themselves (product vocabulary,
  // same contract as the six allowlist entries above) — load-bearing history,
  // not a review-batch label.
  { file: 'CHANGELOG.md', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'P2/P3 name the shipped retrieval-policy tiers described by this entry, consumed by retrieve-context.mjs::applyTierPolicy' },

  // Path→slug / plugin-root / transcript mapping tests: these EXIST to prove the
  // username-generalization logic. Real-looking usernames are the test vectors.
  { file: 'tests/scripts/project-slug.test.mjs', patterns: ['personal-home-username', 'personal-name', 'person-in-prose'], reason: 'path→slug encoding test vectors (dbates, David.Bates28)' },
  { file: 'tests/scripts/resolve-plugin-root.test.mjs', patterns: ['personal-home-username'], reason: 'plugin-root authority-classification test vectors' },
  { file: 'tests/scripts/read-transcript.test.mjs', patterns: ['personal-home-username', 'personal-name', 'person-in-prose'], reason: 'transcript-path slug test vectors' },
  { file: 'tests/scripts/auto-memory-injection-probe.test.mjs', patterns: ['personal-home-username', 'personal-name', 'person-in-prose'], reason: 'mapped-memory-path test vectors' },
  { file: 'tests/scripts/audit-memory-boundary.test.mjs', patterns: ['personal-name', 'person-in-prose'], reason: 'mapped-native-path test vector (David.Bates28)' },
  { file: 'tests/scripts/aggregate-receipt.test.mjs', patterns: ['personal-home-username'], reason: 'refusal-scan test inputs — asserts these paths get redacted' },

  // Retrieval-test persona store: "David" is the user persona in a throwaway
  // watch-buying fixture store. Not shipped behavioral prose. (Judgment call —
  // flagged for a human on whether to rename the persona.)
  { dirPrefix: 'tests/fixtures/obligation3-store/', patterns: ['person-in-prose'], reason: 'retrieval-test user persona in fixture unit bodies' },

  // DC-<n> is load-bearing PRODUCT GRAMMAR: metrics-detectors' CITATION_RE,
  // classify-turns' structured-id extraction, analyze-retrieval-skip's
  // high-signal-token check, and compact-project's `**DC-<n>: Label**`
  // PROJECT.md decision-entry format all match it literally. The six files
  // below carry bare DC tokens ONLY as fixture vectors that exercise that
  // grammar (fictional ids, term-matching inputs, entry-format fixtures,
  // prefix-collision falsifiers) — renaming them would weaken or silently
  // bypass the branches under test. Provenance-style DC refs everywhere in
  // tests/ were rewritten; each entry covers vectors only.
  { file: 'tests/scripts/classify-turns.test.mjs', patterns: ['dc-reference'], reason: 'structured-id extraction and prefix-collision vectors (extractAskedTerm/containsTerm)' },
  { file: 'tests/scripts/analyze-retrieval-skip.test.mjs', patterns: ['dc-reference'], reason: 'retrieval-term vectors in transcript fixtures' },
  { file: 'tests/scripts/audit-memory-boundary.test.mjs', patterns: ['dc-reference'], reason: 'retrieval-term vectors in memory-boundary fixtures' },
  { file: 'tests/scripts/metrics-detectors.test.mjs', patterns: ['dc-reference'], reason: 'CITATION_RE extraction vectors' },
  { file: 'tests/scripts/compact-project.test.mjs', patterns: ['dc-reference'], reason: 'the compactor parses **DC-<n>: Label** entries; fixtures must carry that shape' },
  { file: 'tests/scripts/user-authorship-boundary.test.mjs', patterns: ['dc-reference'], reason: 'PROJECT.md decision-entry format fixtures' },

  // P0-P3 are retrieval-policy enum values consumed by
  // retrieve-context.mjs::applyTierPolicy; renaming would break the runtime
  // policy contract. The bare-label pattern can't distinguish this product
  // enum from an internal review-batch label of the same shape, so each
  // production consumer and its test coverage is allowlisted by exact file.
  { file: 'plugins/core/skills/core/scripts/retrieve-context.mjs', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'P0-P3 are retrieval-policy enum values defined and consumed by applyTierPolicy; renaming would break the runtime policy contract' },
  { file: 'plugins/core/skills/core/scripts/retrieval-harness.mjs', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'P0-P3 retrieval-policy enum values measured against retrieve-context.mjs::applyTierPolicy — the harness names the same runtime contract it evaluates' },
  { file: 'plugins/core/skills/core/scripts/aggregate-receipt.mjs', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'P0-P3 retrieval-policy enum values validated by POLICY_RE against retrieve-context.mjs::applyTierPolicy\'s runtime contract' },
  { file: 'tests/scripts/aggregate-receipt.test.mjs', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'exercises aggregate-receipt.mjs::POLICY_RE, which validates the P0-P3 enum consumed by retrieve-context.mjs::applyTierPolicy' },
  { file: 'tests/scripts/policy-safety.test.mjs', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'exercises retrieve-context.mjs::applyTierPolicy\'s P0-P3 tier-policy contract directly, including the P2 canonical-promotion safety risk' },
  { file: 'tests/scripts/retrieval-premise.test.mjs', patterns: ['internal-review-label-bare'], matches: ['P0', 'P1', 'P2', 'P3'], reason: 'exercises retrieve-context.mjs::applyTierPolicy\'s P0-P3 tier-policy contract directly, including the byte-identical-default control' },
];

// An entry's `matches` array, when present, narrows the exemption to those
// exact literal tokens only — the file+pattern otherwise stays fully scanned,
// so an unrelated bare label sharing the file (e.g. a genuine review-batch
// label alongside the P0-P3 policy enum) still gets caught.
function isAllowed(relPath, patternName, matchValue) {
  return ALLOWLIST.some(
    (e) =>
      (e.file === relPath || (e.dirPrefix && relPath.startsWith(e.dirPrefix))) &&
      (e.patterns === '*' || e.patterns.includes(patternName)) &&
      (!e.matches || e.matches.includes(matchValue)),
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
          if (!isAllowed(rel, p.name, m[0])) {
            findings.push({
              file: rel,
              line: i + 1,
              klass: p.klass,
              pattern: p.name,
              match: m[0],
              text: text.trim().slice(0, 200),
            });
          }
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
