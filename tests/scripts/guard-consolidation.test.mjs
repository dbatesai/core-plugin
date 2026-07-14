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
import { join, dirname } from 'node:path';
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

// Baselines frozen 2026-07-02 (audit fixes branch). Target for each: 1.
// Lower these numbers as the duplication gets consolidated — never raise them.

test('ratchet: slug-encoders outside project-slug.mjs do not grow (target: 0)', () => {
  // project-slug.mjs is the mandated single owner of path->slug encoding; hand-rolled
  // replace() chains elsewhere drift and break on dotted usernames / Windows drives.
  const files = allScripts().filter(p =>
    !p.endsWith('project-slug.mjs') &&
    /replace\(\/\[\^?a-z0-9|replace\(\/\[\/\\\\\]/.test(readFileSync(p, 'utf8')));
  assert.ok(files.length <= 4,
    `slug-encoder copies grew past baseline 4 (target 0 — import mapProjectPathToSlug): ${files.map(f => f.split('/').pop())}`);
});

test('ratchet: local frontmatter fence-parsers do not grow (target: 1)', () => {
  // Multiple hand-rolled "--- ... ---" parsers with subtly different quoting/list
  // handling. frontmatter-flat.mjs / priority.mjs own the canonical ones.
  const n = countMatching(/indexOf\('\\n---'\)|split\(\/\^---/);
  assert.ok(n <= 2, `frontmatter fence-parser copies grew past baseline 2 (target 1): ${n}`);
});

test('ratchet: CLI-entry guards do not grow (target: shared helper)', () => {
  // ~16 hand-copied `import.meta.url === argv[1]` guards in 4 variants, 2 with real
  // bugs (one-sided canonicalization). Freeze the count; a shared isCliEntry() helper
  // is the fix.
  const n = countMatching(/import\.meta\.url/);
  // Baseline 46 → 48 (2026-07-07): two genuinely-new CLI tools, not copy-paste twins.
  // (2026-07-11: embed-index.mjs deleted per DC-114; bm25.mjs replaced it one-for-one,
  // so the 48 ceiling stood re-evaluated, not by accident.) 48 → 49 (2026-07-12):
  // mailbox.mjs, a genuinely-new CLI tool with its own entry point. 49 → 50
  // (2026-07-14): aggregate-receipt.mjs, the Train A A2 privacy exporter — a
  // genuinely-new CLI tool, not a copy. Still target one shared isCliEntry() helper.
  assert.ok(n <= 50, `CLI-entry-guard occurrences grew past baseline 50 (target: one shared helper): ${n}`);
});
