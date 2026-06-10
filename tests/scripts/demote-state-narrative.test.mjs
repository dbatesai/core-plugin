import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  demoteStateNarrative, classifyStateBullet, parseStateBullets, extractStateSection,
  LARGE_BATCH_WARNING_THRESHOLD, ARCHIVE_FILE,
} from '../../plugins/core/skills/core/scripts/demote-state-narrative.mjs';

const TODAY = '2026-06-09';

function unit(status, updated) {
  return ['---', 'type: decision', `status: ${status}`, `created: ${updated}`, `updated: ${updated}`, '---', '', '# Unit', 'body', ''].join('\n');
}

function project(bullets) {
  const dir = mkdtempSync(join(tmpdir(), 'demote-state-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# Test Project', '',
    '## State', '',
    ...bullets, '',
    '## Decisions', '',
    'nothing here', '',
  ].join('\n'));
  return dir;
}

const STALE_BULLET = '- **Old fact.** The store moved long ago. *Backed by dc-9-old-fact.*';
const FRESH_BULLET = '- **Live fact.** Still true today. *Backed by dc-10-live-fact.*';

test('default run is dry-run — candidates reported, nothing written', () => {
  const dir = project([STALE_BULLET]);
  writeFileSync(join(dir, '_memories', 'dc-9-old-fact.md'), unit('archived', '2026-01-01'));
  try {
    const before = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    const stats = demoteStateNarrative(dir, { today: TODAY });
    assert.equal(stats.dry_run, true);
    assert.equal(stats.demoted, 1);
    assert.equal(stats.candidates[0].refs[0], 'dc-9-old-fact');
    assert.equal(readFileSync(join(dir, 'PROJECT.md'), 'utf8'), before, 'PROJECT.md untouched');
    assert.ok(!existsSync(join(dir, ARCHIVE_FILE)), 'no archive created on dry-run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--apply demotes the stale bullet to the archive and leaves a stub', () => {
  const dir = project([STALE_BULLET, FRESH_BULLET]);
  writeFileSync(join(dir, '_memories', 'dc-9-old-fact.md'), unit('archived', '2026-01-01'));
  writeFileSync(join(dir, '_memories', 'dc-10-live-fact.md'), unit('active', '2026-06-01'));
  try {
    const stats = demoteStateNarrative(dir, { today: TODAY, apply: true });
    assert.equal(stats.demoted, 1);
    assert.equal(stats.kept, 1);
    const md = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    assert.ok(md.includes(`- **Old fact.** → see \`PROJECT-ARCHIVE.md §State ${TODAY}\``), 'stub in place');
    assert.ok(md.includes('Still true today'), 'active-cited bullet untouched');
    assert.ok(!md.includes('The store moved long ago'), 'stale body gone from PROJECT.md');
    const archive = readFileSync(join(dir, ARCHIVE_FILE), 'utf8');
    assert.ok(archive.includes('## §State'));
    assert.ok(archive.includes(`### ${TODAY}`));
    assert.ok(archive.includes('The store moved long ago'), 'full bullet preserved in archive');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply is idempotent — the stub never re-demotes', () => {
  const dir = project([STALE_BULLET]);
  writeFileSync(join(dir, '_memories', 'dc-9-old-fact.md'), unit('archived', '2026-01-01'));
  try {
    demoteStateNarrative(dir, { today: TODAY, apply: true });
    const afterFirst = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    const second = demoteStateNarrative(dir, { today: TODAY, apply: true });
    assert.equal(second.demoted, 0);
    assert.equal(readFileSync(join(dir, 'PROJECT.md'), 'utf8'), afterFirst);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a bullet citing a still-active unit is kept', () => {
  const dir = project([FRESH_BULLET]);
  writeFileSync(join(dir, '_memories', 'dc-10-live-fact.md'), unit('active', '2026-01-01'));
  try {
    const state = extractStateSection(readFileSync(join(dir, 'PROJECT.md'), 'utf8'));
    const bullets = parseStateBullets(state);
    const result = classifyStateBullet(bullets[0], dir, { today: TODAY });
    assert.equal(result.decision, 'keep');
    assert.equal(result.reason, 'cited-unit-still-active');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a bullet with no Backed-by footer never demotes', () => {
  const dir = project(['- **Bare claim.** No citation footer here.']);
  try {
    const stats = demoteStateNarrative(dir, { today: TODAY, apply: true });
    assert.equal(stats.demoted, 0);
    assert.equal(stats.kept, 1);
    assert.ok(!existsSync(join(dir, ARCHIVE_FILE)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('large batches emit the demote-state-large-batch warning event', () => {
  const bullets = [];
  for (let i = 0; i < LARGE_BATCH_WARNING_THRESHOLD; i++) {
    bullets.push(`- **Stale fact ${i}.** Old. *Backed by dc-${100 + i}-stale.*`);
  }
  const dir = project(bullets);
  for (let i = 0; i < LARGE_BATCH_WARNING_THRESHOLD; i++) {
    writeFileSync(join(dir, '_memories', `dc-${100 + i}-stale.md`), unit('archived', '2026-01-01'));
  }
  try {
    const stats = demoteStateNarrative(dir, { today: TODAY });
    assert.equal(stats.demoted, LARGE_BATCH_WARNING_THRESHOLD);
    const log = readFileSync(join(dir, '_sessions', TODAY, 'hygiene-log.jsonl'), 'utf8');
    assert.ok(log.includes('"kind":"demote-state-large-batch"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
