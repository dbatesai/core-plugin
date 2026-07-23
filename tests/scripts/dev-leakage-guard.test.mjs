import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanTree, formatReport, PATTERNS, ALLOWLIST } from './dev-leakage-guard.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'leakguard-'));
  const w = (rel, body) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    return abs;
  };
  try {
    return fn({ root, w });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- GREEN: the real shipped tree is clean ----------
test('the current shipped tree has no development leakage', () => {
  const findings = scanTree({ root: REPO_ROOT });
  assert.deepEqual(
    findings,
    [],
    `dev-leakage-guard found leakage in the shipped tree:\n${formatReport(findings)}`,
  );
});

// ---------- RED: a planted leak in each class is caught ----------
test('planted personal path in a skill file is caught', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', 'See /Users/dbates/secret for the config.\n');
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'personal-home-username' && f.file.endsWith('planted.md')),
      'personal-home-username not caught',
    );
    assert.ok(
      findings.some((f) => f.pattern === 'abs-user-path-in-product'),
      'abs-user-path-in-product not caught',
    );
  });
});

test('planted agent name in shipped prose is caught, but not in a code comment', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', "Per Hale's finding, this is fixed.\n");
    w('plugins/core/skills/core/scripts/planted.mjs', "// Per Hale's finding — code comment, not scanned.\n");
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'agent-name-in-prose' && f.file.endsWith('planted.md')),
      'agent name in .md prose not caught',
    );
    assert.ok(
      !findings.some((f) => f.file.endsWith('planted.mjs')),
      'code-comment agent name should NOT be flagged (reported class, not auto-blocked)',
    );
  });
});

test('planted personal-authorization prose (a name in .md) is caught', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', 'Standing authorization for pushes, David 2026.\n');
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'person-in-prose' && f.match === 'David'),
      'person-in-prose not caught',
    );
  });
});

test('planted ~/files default and machine name are caught', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/schemas/planted.json', '{"target_surface": "~/files/collabs/"}\n');
    w('plugins/core/skills/core/protocols/planted.md', 'Ran on Jennifer-Aniston box, R11.\n');
    const findings = scanTree({ root });
    assert.ok(findings.some((f) => f.pattern === 'personal-files-repo'), '~/files not caught');
    assert.ok(findings.some((f) => f.pattern === 'machine-name-jennifer'), 'machine name not caught');
    assert.ok(findings.some((f) => f.pattern === 'machine-name-r11'), 'R11 not caught');
  });
});

// ---------- allowlist behaves ----------
test('owner/copyright name is allowlisted; the same name in prose is not', () => {
  withTree(({ root, w }) => {
    w('LICENSE', 'Copyright (c) 2026 David Bates\n'); // allowlisted file+pattern
    w('plugins/core/skills/core/protocols/planted.md', 'David Bates decided this.\n'); // David + David Bates in prose
    const findings = scanTree({ root });
    assert.ok(
      !findings.some((f) => f.file === 'LICENSE'),
      'LICENSE copyright holder should be allowlisted',
    );
    assert.ok(
      findings.some((f) => f.file.endsWith('planted.md') && f.pattern === 'personal-name'),
      'David Bates in prose should still be caught',
    );
  });
});

test('path-mapping test vectors are allowlisted', () => {
  withTree(({ root, w }) => {
    w('tests/scripts/project-slug.test.mjs', "mapProjectPathToSlug('/Users/dbates/x');\n");
    const findings = scanTree({ root });
    assert.ok(
      !findings.some((f) => f.file === 'tests/scripts/project-slug.test.mjs'),
      'project-slug test vectors should be allowlisted',
    );
  });
});

test('the guard never scans its own source (which contains the deny tokens)', () => {
  withTree(({ root, w }) => {
    // Copy of the guard name in the excluded slot must be skipped even with tokens.
    w('tests/scripts/dev-leakage-guard.mjs', 'const x = "/Users/dbates ~/files Hale";\n');
    const findings = scanTree({ root });
    assert.equal(findings.length, 0, 'the scanner must exclude its own files');
  });
});

// ---------- structural sanity ----------
test('every allowlist entry names a real pattern and carries a reason', () => {
  const names = new Set(PATTERNS.map((p) => p.name));
  for (const e of ALLOWLIST) {
    assert.ok(e.file || e.dirPrefix, 'allowlist entry needs a file or dirPrefix');
    assert.ok(typeof e.reason === 'string' && e.reason.length > 0, 'allowlist entry needs a reason');
    const pats = e.patterns === '*' ? [] : e.patterns;
    for (const p of pats) assert.ok(names.has(p), `allowlist names unknown pattern "${p}"`);
  }
});
