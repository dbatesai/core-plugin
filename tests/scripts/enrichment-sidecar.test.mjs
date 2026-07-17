import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  enrichmentSidecarPath,
  loadValidEnrichments,
  writeEnrichment,
} from '../../plugins/core/skills/core/scripts/enrichment-sidecar.mjs';
import { loadSnapshot } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { productRankedIds } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

function store() {
  const root = mkdtempSync(join(tmpdir(), 'core-enrichment-'));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

const payload = {
  unitPath: 'values-heritage.md',
  writerModelFamily: 'fable',
  answerModelFamily: 'opus',
  aliases: ['zenith el primero'],
  paraphrases: ['original landmark chronograph movement'],
  likelyQuestions: ['Which watch best matches a preference for the El Primero?'],
};

test('writer fails closed on same-family generation and persists a hash-keyed sidecar', () => {
  const root = store();
  try {
    assert.throws(() => writeEnrichment(root, { ...payload, answerModelFamily: 'FABLE' }), /different model famil/i);
    const written = writeEnrichment(root, payload);
    const raw = JSON.parse(readFileSync(enrichmentSidecarPath(root), 'utf8'));
    assert.equal(raw.schema, 'core-enrichment-sidecar/1');
    assert.ok(raw.records[written.source_sha256]);
    assert.equal(raw.records[written.source_sha256].unit_id, 'values-heritage');
    assert.equal(raw.records[written.source_sha256].writer_model_family, 'fable');
    assert.equal(raw.records[written.source_sha256].answer_model_family, 'opus');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('edited units invalidate stale enrichment and change the captured product identity', () => {
  const root = store();
  try {
    const before = loadSnapshot(root, { captureBodies: true });
    writeEnrichment(root, payload);
    const enriched = loadSnapshot(root, { captureBodies: true });
    assert.notEqual(enriched.snapshotId, before.snapshotId, 'valid enrichment is part of product identity');
    assert.equal(enriched.enrichments.documents.length, 1);

    const file = join(root, '_memories', payload.unitPath);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nEdited after enrichment.\n`);
    const edited = loadSnapshot(root, { captureBodies: true });
    assert.equal(edited.enrichments.documents.length, 0, 'source hash mismatch makes enrichment stale');
    assert.equal(edited.enrichments.stale_count, 1);

    const direct = loadValidEnrichments(root, edited.index, edited.source_sha256_by_path);
    assert.equal(direct.documents.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('product ranking consumes valid enrichment as a separately weighted arm', () => {
  const root = store();
  try {
    const query = 'el primero recommendation';
    const before = loadSnapshot(root, { captureBodies: true });
    assert.ok(!productRankedIds(query, root, { snapshot: before }).includes('values-heritage'));

    writeEnrichment(root, payload);
    const after = loadSnapshot(root, { captureBodies: true });
    assert.ok(productRankedIds(query, root, { snapshot: after }).includes('values-heritage'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the unit-write protocol requires different-family enrichment and the governed CLI', () => {
  const protocol = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'protocols', 'data-storage.md'), 'utf8');
  assert.match(protocol, /After every unit create or edit/i);
  assert.match(protocol, /different model family/i);
  assert.match(protocol, /enrichment-sidecar\.mjs/);
  assert.match(protocol, /Never copy the authored body or hidden evaluation queries/i);
});
