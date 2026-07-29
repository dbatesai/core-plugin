import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanTree, formatReport, PATTERNS, ALLOWLIST, SCAN_EXCLUDE } from './dev-leakage-guard.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// This file IS scanned by the guard (it is deliberately NOT in SCAN_EXCLUDE):
// a scanner whose own test file is exempt has a blind spot exactly where leaks
// are most likely to be pasted. Every planted deny token below is therefore
// CONSTRUCTED FROM FRAGMENTS at runtime — the source of this file never
// contains a matchable token, so the live-tree scan stays clean while the
// planted trees still exercise every pattern.
const FRAG = {
  user: 'dba' + 'tes',                      // personal username
  person: 'Da' + 'vid',                     // personal first name
  personFull: 'Da' + 'vid ' + 'Ba' + 'tes', // personal full name
  agent: 'Ha' + 'le',                       // reviewer agent name
  agent2: 'A' + 'gy',                       // second reviewer agent name
  agentLower: 'ke' + 'el',                  // lowercase agent name
  filesRepo: '~/fi' + 'les',
  machine: 'Jennifer-' + 'Aniston',
  machine2: 'R' + '11',
  dc: (n) => 'DC-' + n,                     // decision-ledger ref
  issue: (p, n) => p + n,                   // internal issue id, e.g. issue('AUD-', '104')
};

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

// ---------- the exclusion set is exactly the scanner implementation ----------
test('only the scanner implementation is excluded from scanning, and the exclusion is honest', () => {
  // The implementation must stay excluded — its PATTERNS hold literal deny
  // tokens as machine data, so scanning it can only ever false-positive. This
  // test file must NOT be excluded — its planted tokens are fragment-built.
  assert.deepEqual([...SCAN_EXCLUDE], ['tests/scripts/dev-leakage-guard.mjs'],
    'the exclusion set must be exactly the scanner implementation, nothing more');
});

// ---------- RED: a planted leak in each class is caught ----------
test('planted personal path in a skill file is caught', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', `See /Users/${FRAG.user}/secret for the config.\n`);
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

test('planted agent name is caught in shipped prose AND in shipped code comments', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', `Per ${FRAG.agent}'s finding, this is fixed.\n`);
    w('plugins/core/skills/core/scripts/planted.mjs', `// Per ${FRAG.agent}'s finding — a shipped code comment.\n`);
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'agent-name-in-prose' && f.file.endsWith('planted.md')),
      'agent name in .md prose not caught',
    );
    assert.ok(
      findings.some((f) => f.pattern === 'agent-name-in-prose' && f.file.endsWith('planted.mjs')),
      'agent name in shipped plugins/ code comment not caught',
    );
  });
});

test('agent-name boundaries: lowercase, uppercase, underscore-slug, and hyphen-slug all match', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', [
      `the ${FRAG.agentLower} convention`,             // bare lowercase
      `${FRAG.agentLower.toUpperCase()} SAID SO`,      // bare uppercase
      `reference_${FRAG.agentLower}_handoff_channels`, // underscore slug (\b cannot see this)
      `per-${FRAG.agent2.toLowerCase()}-review`,       // hyphen slug
    ].join('\n') + '\n');
    const findings = scanTree({ root }).filter((f) => f.pattern === 'agent-name-in-prose');
    assert.equal(findings.length, 4,
      `all four boundary/case forms must be findings, got:\n${formatReport(findings)}`);
  });
});

test('planted DC-reference is caught everywhere: product surface, CHANGELOG, and tests/', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', `Graduation links per ${FRAG.dc('94a')}.\n`);
    w('CHANGELOG.md', `- Fixed per ${FRAG.dc('114')}.\n`);
    w('tests/scripts/planted.test.mjs', `// ACCEPTANCE ${FRAG.dc('116')} item 3 — provenance traceability stays.\n`);
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'dc-reference' && f.file.endsWith('planted.md')),
      'DC-ref in shipped protocol prose not caught',
    );
    assert.ok(
      findings.some((f) => f.pattern === 'dc-reference' && f.file === 'CHANGELOG.md'),
      'DC-ref in CHANGELOG not caught',
    );
    assert.ok(
      findings.some((f) => f.pattern === 'dc-reference' && f.file.startsWith('tests/')),
      'DC-ref in a test file not caught — internal-process checks apply to all tracked text',
    );
  });
});

test('planted personal-authorization prose (a name in .md) is caught', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/protocols/planted.md', `Standing authorization for pushes, ${FRAG.person} 2026.\n`);
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'person-in-prose' && f.match === FRAG.person),
      'person-in-prose not caught',
    );
  });
});

test('planted personal-files default and machine name are caught', () => {
  withTree(({ root, w }) => {
    w('plugins/core/skills/core/schemas/planted.json', `{"target_surface": "${FRAG.filesRepo}/collabs/"}\n`);
    w('plugins/core/skills/core/protocols/planted.md', `Ran on ${FRAG.machine} box, ${FRAG.machine2}.\n`);
    const findings = scanTree({ root });
    assert.ok(findings.some((f) => f.pattern === 'personal-files-repo'), 'personal files repo not caught');
    assert.ok(findings.some((f) => f.pattern === 'machine-name-jennifer'), 'machine name not caught');
    assert.ok(findings.some((f) => f.pattern === 'machine-name-r11'), 'second machine name not caught');
  });
});

// ---------- allowlist behaves ----------
test('owner/copyright name is allowlisted; the same name in prose is not', () => {
  withTree(({ root, w }) => {
    w('LICENSE', `Copyright (c) 2026 ${FRAG.personFull}\n`); // allowlisted file+pattern
    w('plugins/core/skills/core/protocols/planted.md', `${FRAG.personFull} decided this.\n`);
    const findings = scanTree({ root });
    assert.ok(
      !findings.some((f) => f.file === 'LICENSE'),
      'LICENSE copyright holder should be allowlisted',
    );
    assert.ok(
      findings.some((f) => f.file.endsWith('planted.md') && f.pattern === 'personal-name'),
      'a personal full name in prose should still be caught',
    );
  });
});

test('path-mapping test vectors are allowlisted', () => {
  withTree(({ root, w }) => {
    w('tests/scripts/project-slug.test.mjs', `mapProjectPathToSlug('/Users/${FRAG.user}/x');\n`);
    const findings = scanTree({ root });
    assert.ok(
      !findings.some((f) => f.file === 'tests/scripts/project-slug.test.mjs'),
      'project-slug test vectors should be allowlisted',
    );
  });
});

test('the scanner implementation stays excluded; its own TEST file is scanned', () => {
  withTree(({ root, w }) => {
    const tokens = `const x = "/Users/${FRAG.user} ${FRAG.filesRepo} ${FRAG.agent}";\n`;
    // Tokens at the implementation path are skipped (literal pattern data lives there)…
    w('tests/scripts/dev-leakage-guard.mjs', tokens);
    assert.equal(scanTree({ root }).length, 0, 'the scanner implementation must stay excluded');
    // …but the SAME tokens at the test-file path are findings: the old blanket
    // self-exclusion recreated a blind spot, and this pins that it stays gone.
    w('tests/scripts/dev-leakage-guard.test.mjs', tokens);
    assert.ok(scanTree({ root }).length > 0, 'the guard test file must be scanned like any other tracked file');
  });
});

// ---------- FALSIFIER: a dated reviewer/ruling sentence outside literal-pattern data is RED ----------
test('a dated reviewer ruling sentence planted in the guard TEST file is a finding', () => {
  withTree(({ root, w }) => {
    w('tests/scripts/dev-leakage-guard.test.mjs',
      `// ${FRAG.agent} ruled 2026-07-24: tests keep provenance traceability.\n`);
    const findings = scanTree({ root });
    assert.ok(
      findings.some((f) => f.pattern === 'agent-name-in-prose' && f.file === 'tests/scripts/dev-leakage-guard.test.mjs'),
      'a dated reviewer/ruling sentence in the guard test file must be RED',
    );
  });
});

// ---------- planted-leak falsifiers: a named-review line under tests/ and under CHANGELOG.md must both fail ----------
test('a named-review line planted in a test file is a finding', () => {
  withTree(({ root, w }) => {
    w(
      'tests/scripts/some-feature.test.mjs',
      `test('${FRAG.issue('AUD-', '104')} refusal path (${FRAG.agent} round-2 retest)', () => {});\n`,
    );
    const hits = scanTree({ root }).filter((f) => f.file === 'tests/scripts/some-feature.test.mjs');
    assert.ok(
      hits.some((f) => f.pattern === 'agent-name-in-prose'),
      'the planted reviewer name in a test title must be a finding',
    );
    assert.ok(
      hits.some((f) => f.pattern === 'internal-issue-id'),
      'the planted internal issue id in a test title must be a finding',
    );
  });
});

test('a named-review line planted in CHANGELOG.md is a finding', () => {
  withTree(({ root, w }) => {
    w('CHANGELOG.md', `## [9.9.9]\n- Fixed per ${FRAG.agent2} mailbox round 2; ${FRAG.issue('HC_', '539')} closed.\n`);
    const hits = scanTree({ root }).filter((f) => f.file === 'CHANGELOG.md');
    assert.ok(
      hits.some((f) => f.pattern === 'agent-name-in-prose'),
      'the planted reviewer name in the changelog must be a finding',
    );
    assert.ok(
      hits.some((f) => f.pattern === 'internal-issue-id'),
      'the planted internal issue id in the changelog must be a finding',
    );
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
