// REGRESSION GUARD — pattern 2: "fixed once, never swept."
//
// The audit's most common defect: a bug fixed in one file, left live in its
// copy-paste twins. These are RATCHET tests. Each asserts the count of a
// duplicated implementation does not EXCEED a frozen baseline — so a new copy
// fails CI immediately. The target for every one of these is 1 (a single shared
// owner). When you consolidate, LOWER the baseline here in the same commit; the
// ratchet only clicks tighter, never looser.
//
// How to read a failure: "expected <= N, got N+1" means someone added another
// copy of a thing that should have one home. Import the shared owner instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts');

function allScripts() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) out.push(p);
    }
  };
  walk(SCRIPTS);
  return out;
}
const countMatching = (re) => allScripts().filter(p => re.test(readFileSync(p, 'utf8'))).length;

// Baselines frozen 2026-07-02. Target for each: 1.
// Lower these numbers as the duplication gets consolidated — never raise them.

test('ratchet: slug-encoders outside project-slug.mjs do not grow (target: 0)', () => {
  // project-slug.mjs is the mandated single owner of path->slug encoding; hand-rolled
  // replace() chains elsewhere drift and break on dotted usernames / Windows drives.
  const files = allScripts().filter(p =>
    !p.endsWith('project-slug.mjs') &&
    /replace\(\/\[\^?a-z0-9|replace\(\/\[\/\\\\\]/.test(readFileSync(p, 'utf8')));
  assert.ok(files.length <= 4,
    `slug-encoder copies grew past baseline 4 (target 0 — import mapProjectPathToSlug): ${files.map(f => basename(f))}`);
});

test('ban: hand-rolled frontmatter fence-parsers do not come back', () => {
  // frontmatter-flat.mjs / priority.mjs own the canonical parsers; every
  // hand-rolled copy has been consolidated, so the count is a hard zero — a
  // single new copy fails this immediately.
  const n = countMatching(/indexOf\('\\n---'\)|split\(\/\^---/);
  assert.equal(n, 0, `a hand-rolled frontmatter fence-parser appeared (import frontmatter-flat.mjs instead): ${n}`);
});

test('ratchet: CLI-entry guards do not grow (target: shared helper)', () => {
  // Every occurrence of import.meta.url in scripts/ is either a CLI entry
  // point calling the shared isCliEntry() helper or a module-relative path
  // resolution. The ceiling counts files, one per legitimate use; a new file
  // must justify its own entry point to raise it — never a copy-paste twin.
  const n = countMatching(/import\.meta\.url/);
  assert.ok(n <= 65, `CLI-entry-guard occurrences grew past baseline 65 (target: one shared helper): ${n}`);
});

test('LOCAL CLI-entry guard implementations: exactly the bootstrap resolver, everything else imports isCliEntry', () => {
  // cli-entry.mjs owns the one symlink-hardened entry-point comparison. Every
  // other script and hook calls isCliEntry(import.meta.url). The single
  // sanctioned local implementation is resolve-plugin-root.mjs: the identity
  // gate executes as a lone copied file before siblings exist, so it cannot
  // import cli-entry.mjs (see the comment at its guard). A "local
  // implementation" is any line that compares process.argv[1] against the
  // module's own path — in any spelling, including a named canonicalizer
  // wrapper. Scans hooks/ too: a hook entry point is as guard-bearing as a
  // script.
  const HOOKS = join(SCRIPTS, '..', 'hooks');
  const files = [];
  for (const dir of [SCRIPTS, HOOKS]) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.mjs') || e.name === 'cli-entry.mjs') continue;
      const text = readFileSync(join(dir, e.name), 'utf8');
      const hasLocalGuard = /process\.argv\[1\][^\n]*(?:===|realpathSync|pathToFileURL|basename\()/.test(text)
        || /(?:realpathSync|resolve|_canon|\w*[Cc]anonical\w*)\([^\n]*process\.argv\[1\]/.test(text);
      if (hasLocalGuard && !/import \{ isCliEntry \}/.test(text)) files.push(e.name);
    }
  }
  assert.deepEqual(new Set(files), new Set(['resolve-plugin-root.mjs']),
    `unexpected LOCAL CLI-entry guard — call isCliEntry(import.meta.url) from cli-entry.mjs instead: ${files.join(', ')}`);
});
