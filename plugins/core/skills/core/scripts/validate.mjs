/**
 * CORE v2 validation runner.
 *
 * Usage: node validate.mjs <project-path>
 *
 * Reads test corpus from <project-path>/_memories/_validation/tests/test-*.yaml
 * Runs Tier 1 retrieval simulation (term-density scoring) for each test
 * Scores precision + recall against expected/forbidden unit lists
 * Writes report to <project-path>/_outputs/validation/<date>/REPORT.md
 *
 * NOT-PRODUCT-PATH: this simulator is
 * its own term-density scorer with negation handling — it is NOT the shipped
 * retriever (`retrieve-context.mjs` productRankedScores, title ∪ body-BM25). Its
 * results are retrieval-health diagnostics; they must never be cited as product
 * baselines or used to clear a release gate. Migrating it to the product
 * ranking would change historical validation comparability, so that migration
 * is a deliberate, explicit decision — never a drive-by change.
 *
 * The plugin ships Node.js (.mjs) only.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isCliEntry } from './cli-entry.mjs';

export function parseFrontmatter(content) {
  content = content.replace(/\r\n?/g, '\n'); // CRLF tolerance
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fmText = match[1];
  const result = {};
  let currentKey = null;
  let currentList = null;
  for (const line of fmText.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('  - ') || line.startsWith('- ')) {
      const value = line.trimStart().slice(2).trim().replace(/^["']|["']$/g, '');
      if (currentList !== null) currentList.push(value);
      continue;
    }
    if (line.includes(':') && !line.startsWith(' ')) {
      if (currentKey && currentList !== null) {
        result[currentKey] = currentList;
        currentList = null;
      }
      const colonIdx = line.indexOf(':');
      const k = line.slice(0, colonIdx).trim();
      const v = line.slice(colonIdx + 1).trim();
      currentKey = k;
      if (!v) {
        currentList = [];
      } else if (v.startsWith('[') && v.endsWith(']')) {
        result[k] = v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        currentKey = null;
        currentList = null;
      } else {
        result[k] = v.replace(/^["']|["']$/g, '');
        currentKey = null;
        currentList = null;
      }
    }
  }
  if (currentKey && currentList !== null) result[currentKey] = currentList;
  return result;
}

export function loadTests(projectPath) {
  const testsDir = join(projectPath, '_memories/_validation/tests');
  const tests = [];
  let entries;
  try { entries = readdirSync(testsDir).sort(); } catch { return tests; }
  for (const fname of entries) {
    if (!fname.startsWith('test-') || !fname.endsWith('.yaml')) continue;
    const content = readFileSync(join(testsDir, fname), 'utf8');
    const fm = parseFrontmatter(content);
    if (fm && fm.query) tests.push(fm);
  }
  return tests;
}

export const STOPWORDS = new Set([
  'the','and','for','are','was','but','not','you','all','any',
  'can','had','has','his','her','how','its','may','now','one',
  'our','out','own','see','she','two','use','via','way','who',
  'why','yes','yet',
  'what','where','which','would','could','should','their','there',
  'these','those','about','after','again','before','being','below',
  'between','during','other','while','every','based','into','than',
  'then','this','that','they','from','have','with','your','just',
  'like','make','more','much','only','over','some','such','very',
  'when','will','also','back','been','both','down','even','ever',
  'here','many','much','must','need','same','well',
  'dont','isnt','wont','cant','doesnt','wouldnt','couldnt',
]);

export function extractQueryFeatures(query) {
  const rawTerms = query.split(/\s+/).map(t => t.toLowerCase().replace(/[.,?!()[\]"']/g, '')).filter(Boolean);
  const terms = [];
  const negatedTerms = [];
  for (let i = 0; i < rawTerms.length; i += 1) {
    const term = rawTerms[i];
    const next = rawTerms[i + 1];
    if (term === 'no' && next && next.length >= 3 && !STOPWORDS.has(next)) {
      negatedTerms.push(next);
      i += 1;
      continue;
    }
    if (term.length >= 3 && !STOPWORDS.has(term)) terms.push(term);
  }
  return {
    terms: [...new Set(terms)],
    negatedTerms: [...new Set(negatedTerms)],
  };
}

function hasNegatedTerm(content, term) {
  return content.includes(`no ${term}`);
}

export function simulateRetrievalTier1(query, projectPath, topK = 3) {
  const unitsDir = join(projectPath, '_memories');
  const { terms, negatedTerms } = extractQueryFeatures(query);
  if (!terms.length && !negatedTerms.length) return [];

  const scored = [];
  function walkDir(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (['archive', 'cold-storage', '_validation'].includes(entry.name)) continue;
        walkDir(join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('INDEX') || entry.name.startsWith('README') || entry.name.startsWith('_')) continue;
      const fpath = join(dir, entry.name);
      try {
        const content = readFileSync(fpath, 'utf8').toLowerCase();
        const slug = entry.name.replace(/\.md$/, '').toLowerCase();
        const bodyHits = terms.reduce((n, t) => n + (content.includes(t) ? 1 : 0), 0);
        const slugHits = terms.reduce((n, t) => n + (slug.includes(t) ? 1 : 0), 0);
        const negatedHits = negatedTerms.reduce((n, t) => n + (hasNegatedTerm(content, t) ? 1 : 0), 0);
        const contradictedNegations = negatedTerms.reduce((n, t) => {
          if (!content.includes(t) && !slug.includes(t)) return n;
          return hasNegatedTerm(content, t) ? n : n + 1;
        }, 0);
        const s = bodyHits + 2 * slugHits + negatedHits - 10 * contradictedNegations;
        if (s > 0) scored.push([s, entry.name.replace(/\.md$/, '')]);
      } catch {}
    }
  }
  walkDir(unitsDir);

  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, topK).map(x => x[1]);
}

export function scorePrecisionRecall(retrieved, expected, forbidden) {
  const retSet = new Set(retrieved);
  const expSet = new Set(expected || []);
  const forbSet = new Set(forbidden || []);
  const cleanRet = new Set([...retSet].filter(x => !forbSet.has(x)));
  const tp = [...cleanRet].filter(x => expSet.has(x)).length;
  const fp = [...retSet].filter(x => forbSet.has(x)).length;
  if (!expSet.size) {
    return [fp > 0 ? 0.0 : 1.0, 1.0];
  }
  if (fp > 0) {
    return [0.0, Math.round((tp / Math.max(expSet.size, 1)) * 100) / 100];
  }
  const precision = tp / Math.max(cleanRet.size, 1);
  const recall = tp / Math.max(expSet.size, 1);
  return [Math.round(precision * 100) / 100, Math.round(recall * 100) / 100];
}

export function main(argv) {
  if (!argv[0]) {
    process.stderr.write('Usage: node validate.mjs <project-path>\n');
    process.exit(1);
  }

  const projectPath = resolve(argv[0]);
  const tests = loadTests(projectPath);

  if (!tests.length) {
    console.log(`No tests found in ${projectPath}/_memories/_validation/tests/`);
    process.exit(0);
  }

  const results = [];
  for (const t of tests) {
    const query = t.query || '';
    let expected = t.expected_memories || [];
    let forbidden = t.forbidden_memories || [];
    if (typeof expected === 'string') expected = expected ? [expected] : [];
    if (typeof forbidden === 'string') forbidden = forbidden ? [forbidden] : [];
    const scoreK = Math.max(1, expected.length);
    const candidateK = Math.max(5, scoreK);
    const candidates = simulateRetrievalTier1(query, projectPath, candidateK);
    const retrieved = candidates.slice(0, scoreK);
    // The forbidden check spans the whole candidate pool (candidateK): a forbidden unit
    // surfacing anywhere in retrieval is a failure, even below the scoreK precision cut —
    // that's the designed semantic (see the "not first, but still in the candidate set" test).
    const forbiddenHits = candidates.filter(x => forbidden.includes(x));
    let [p, r] = scorePrecisionRecall(retrieved, expected, forbidden);
    // scorePrecisionRecall only sees the scoreK slice, so a forbidden ranked between
    // scoreK and candidateK left status=FAIL while P/R both read 1.0 — the confusing
    // `FAIL | 1.0 | 1.0` row. A contaminated candidate pool zeroes the run's precision so
    // the row is internally consistent (FAIL | 0.0 | R) without weakening the forbidden check.
    if (forbiddenHits.length) p = 0.0;
    const status = forbiddenHits.length ? 'FAIL' : (p >= 0.8 && r >= 0.8) ? 'PASS' : (p < 0.5 || r < 0.5) ? 'FAIL' : 'INVESTIGATE';
    results.push({ query, precision: p, recall: r, status, retrieved: candidates.slice(0, 5), expected, forbiddenHits });
    const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'INV';
    console.log(`[${icon}] P=${p} R=${r} -- ${query.slice(0, 60)}`);
  }

  const passes = results.filter(r => r.status === 'PASS').length;
  const fails = results.filter(r => r.status === 'FAIL').length;

  const dateStr = new Date().toISOString().slice(0, 10);
  const reportDir = join(projectPath, `_outputs/validation/${dateStr}`);
  mkdirSync(reportDir, { recursive: true });

  const reportLines = [
    `# Validation Report -- ${dateStr}\n\n`,
    `**Results: ${passes}/${results.length} pass, ${fails} fail**\n\n`,
    '| Status | P | R | Query |\n',
    '|---|---|---|---|\n',
  ];
  for (const r of results) {
    reportLines.push(`| ${r.status} | ${r.precision} | ${r.recall} | \`${r.query.slice(0, 70)}\` |\n`);
  }
  reportLines.push('\n## Detail\n\n');
  for (const r of results) {
    reportLines.push(`**${r.query}**  \nExpected: ${JSON.stringify(r.expected)}  \nRetrieved (top 5): ${JSON.stringify(r.retrieved)}  \nForbidden hits: ${JSON.stringify(r.forbiddenHits)}\n\n`);
  }

  const reportPath = join(reportDir, 'REPORT.md');
  writeFileSync(reportPath, reportLines.join(''));
  console.log(`\nReport: ${reportPath}`);

  if (fails > 0) {
    console.log(`\n${fails} FAIL(s) -- PAUSE-AND-SURFACE TRIGGER if any precision or recall < 0.5`);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2));
}
