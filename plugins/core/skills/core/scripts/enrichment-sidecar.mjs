#!/usr/bin/env node
/**
 * Governed write-time enrichment storage for DC-114/DC-115.
 *
 * This module never invokes a model. A cloud agent from a model family different
 * from the answering family supplies aliases, paraphrases, and likely questions.
 * The writer validates provenance and keys each record by the source file's
 * SHA-256. Retrieval ignores a record as soon as its source bytes change.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { parseFrontmatter } from './priority.mjs';

export const ENRICHMENT_SCHEMA = 'core-enrichment-sidecar/1';

export function enrichmentSidecarPath(store) {
  return join(resolve(store), '_memories', '_lib', 'enrichment-sidecar.json');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedFamily(value, field) {
  const out = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(out)) throw new Error(`${field} must name a model family`);
  return out;
}

function strings(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const out = [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))];
  if (out.some((v) => v.length > 500)) throw new Error(`${field} entries must be at most 500 characters`);
  return out;
}

function safeUnitPath(value) {
  const rel = String(value || '').replaceAll('\\', '/');
  if (!rel.endsWith('.md') || rel.startsWith('/') || rel.split('/').some((part) => !part || part === '..' || part.startsWith('_'))) {
    throw new Error('unitPath must be a safe unit path relative to _memories');
  }
  return rel;
}

function loadRawSidecar(store) {
  const path = enrichmentSidecarPath(store);
  if (!existsSync(path)) return { schema: ENRICHMENT_SCHEMA, records: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed?.schema !== ENRICHMENT_SCHEMA || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
    throw new Error(`invalid enrichment sidecar schema at ${path}`);
  }
  return parsed;
}

export function writeEnrichment(store, {
  unitPath,
  writerModelFamily,
  answerModelFamily,
  aliases = [],
  paraphrases = [],
  likelyQuestions = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const root = resolve(store);
  const rel = safeUnitPath(unitPath);
  const sourcePath = join(root, '_memories', ...rel.split('/'));
  const source = readFileSync(sourcePath);
  const writer = normalizedFamily(writerModelFamily, 'writerModelFamily');
  const answer = normalizedFamily(answerModelFamily, 'answerModelFamily');
  if (writer === answer) throw new Error('write-time enrichment requires a different model family from the answering model family');

  const aliasList = strings(aliases, 'aliases');
  const paraphraseList = strings(paraphrases, 'paraphrases');
  const questionList = strings(likelyQuestions, 'likelyQuestions');
  if (!aliasList.length && !paraphraseList.length && !questionList.length) throw new Error('enrichment must contain at least one search phrase');

  const [frontmatter] = parseFrontmatter(source.toString('utf8'));
  const unitId = String(frontmatter?.id || rel.split('/').pop().slice(0, -3));
  const sourceHash = sha256(source);
  const sidecar = loadRawSidecar(root);
  // An edited unit gets one current record. Old hash-keyed records for this unit
  // are removed atomically; retrieval would ignore them either way.
  for (const [key, record] of Object.entries(sidecar.records)) {
    if (record?.unit_id === unitId || record?.source_path === rel) delete sidecar.records[key];
  }
  const record = {
    unit_id: unitId,
    source_path: rel,
    source_sha256: sourceHash,
    writer_model_family: writer,
    answer_model_family: answer,
    generated_at: String(generatedAt),
    aliases: aliasList,
    paraphrases: paraphraseList,
    likely_questions: questionList,
  };
  sidecar.records[sourceHash] = record;
  const path = enrichmentSidecarPath(root);
  mkdirSync(join(root, '_memories', '_lib'), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(sidecar, null, 2)}\n`);
  try { chmodSync(path, 0o600); } catch { /* Windows/filesystem may not expose POSIX mode */ }
  return record;
}

export function loadValidEnrichments(store, index, sourceSha256ByPath = {}) {
  const sidecar = loadRawSidecar(store);
  const byPath = new Map((index?.units || []).map((unit) => [unit.path, unit]));
  const documents = [];
  const validRecords = [];
  let stale = 0;
  for (const [key, record] of Object.entries(sidecar.records).sort(([a], [b]) => a.localeCompare(b))) {
    const unit = byPath.get(record?.source_path);
    const currentHash = sourceSha256ByPath[record?.source_path];
    const familiesDiffer = record?.writer_model_family && record?.answer_model_family
      && String(record.writer_model_family).toLowerCase() !== String(record.answer_model_family).toLowerCase();
    if (!unit || !currentHash || key !== currentHash || record.source_sha256 !== currentHash || record.unit_id !== unit.id || !familiesDiffer) {
      stale += 1;
      continue;
    }
    const text = [
      ...(Array.isArray(record.aliases) ? record.aliases : []),
      ...(Array.isArray(record.paraphrases) ? record.paraphrases : []),
      ...(Array.isArray(record.likely_questions) ? record.likely_questions : []),
    ].map(String).join('\n').trim();
    if (!text) { stale += 1; continue; }
    documents.push({ id: unit.id, tier: unit.tier || 'canonical', text });
    validRecords.push(record);
  }
  const digest = sha256(JSON.stringify(validRecords));
  return { documents, digest, valid_count: documents.length, stale_count: stale };
}

function main(argv) {
  const store = argv[0];
  const unitPath = argv[1];
  const inputIdx = argv.indexOf('--input');
  const writerIdx = argv.indexOf('--writer-family');
  const answerIdx = argv.indexOf('--answer-family');
  if (!store || !unitPath || inputIdx < 0 || writerIdx < 0 || answerIdx < 0) {
    process.stderr.write('usage: enrichment-sidecar.mjs <store> <unit-path> --input <json> --writer-family <family> --answer-family <family>\n');
    return 2;
  }
  const payload = JSON.parse(readFileSync(argv[inputIdx + 1], 'utf8'));
  const record = writeEnrichment(store, {
    unitPath,
    writerModelFamily: argv[writerIdx + 1],
    answerModelFamily: argv[answerIdx + 1],
    aliases: payload.aliases,
    paraphrases: payload.paraphrases,
    likelyQuestions: payload.likely_questions || payload.likelyQuestions,
  });
  process.stdout.write(`${JSON.stringify({ written: true, unit_id: record.unit_id, source_sha256: record.source_sha256 })}\n`);
  return 0;
}

if (basename(process.argv[1] || '') === 'enrichment-sidecar.mjs') {
  try { process.exit(main(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
