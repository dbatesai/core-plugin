import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractCitations, buildUnitIndex, resolveCitation, runCitationResolver,
} from '../../plugins/core/skills/core/scripts/metrics-detectors.mjs';

test('extractCitations pulls DC-XX, R-XX, and [[wikilinks]]', () => {
  const cs = extractCitations('Per DC-104 and R-5, see [[obs-foo-2026]].');
  assert.deepEqual(cs.map((c) => c.key), ['dc-104', 'risk-5', 'obs-foo-2026']);
  assert.deepEqual(cs.map((c) => c.kind), ['decision', 'risk', 'wikilink']);
});

function withStore(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'detstore-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const f of files) writeFileSync(join(mem, f), '# unit\n');
  try { return fn(mem); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('buildUnitIndex derives ids + dc/risk claim-keys from filenames', () => {
  withStore(['dc-104-harness-agnostic.md', 'risk-5-validation.md', 'obs-foo-2026.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    assert.ok(idx.claimKeys.has('dc-104'));
    assert.ok(idx.claimKeys.has('risk-5'));
    assert.ok(idx.ids.has('obs-foo-2026'));
  });
});

test('resolveCitation: real references resolve, fabricated ones do not', () => {
  withStore(['dc-104-harness-agnostic.md', 'risk-5-validation.md', 'obs-foo-2026.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    assert.equal(resolveCitation({ kind: 'decision', key: 'dc-104' }, idx), true);
    assert.equal(resolveCitation({ kind: 'risk', key: 'risk-5' }, idx), true);
    assert.equal(resolveCitation({ kind: 'wikilink', key: 'obs-foo-2026' }, idx), true);
    assert.equal(resolveCitation({ kind: 'wikilink', key: 'obs-foo' }, idx), true); // prefix tolerance
    assert.equal(resolveCitation({ kind: 'decision', key: 'dc-999' }, idx), false); // fabricated
    assert.equal(resolveCitation({ kind: 'wikilink', key: 'obs-nonexistent' }, idx), false);
  });
});

test('runCitationResolver flags only the broken references in agent text', () => {
  withStore(['dc-104-harness-agnostic.md', 'risk-5-validation.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    const events = [
      { role: 'assistant', kind: 'text', text: 'Per DC-104 this holds.' }, // valid
      { role: 'assistant', kind: 'text', text: 'As DC-999 shows, and [[obs-ghost]].' }, // both broken
      { role: 'user', kind: 'text', text: 'what about DC-777' }, // user text — ignored
    ];
    const broken = runCitationResolver(events, idx);
    assert.equal(broken.length, 2);
    assert.deepEqual(broken.map((b) => b.key).sort(), ['dc-999', 'obs-ghost']);
  });
});

test('runCitationResolver dedupes repeated citations', () => {
  withStore(['dc-104.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    const events = [
      { role: 'assistant', kind: 'text', text: 'DC-999 DC-999 DC-999' },
    ];
    assert.equal(runCitationResolver(events, idx).length, 1, 'one unique broken ref, not three');
  });
});
