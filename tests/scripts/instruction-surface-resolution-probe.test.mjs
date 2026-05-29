import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPrecedenceChain, classifyInstructionSurface, probe, SCHEMA_VERSION, CAPABILITY_ID,
} from '../../skills/core/scripts/capability/instruction-surface-resolution-probe.mjs';

const VALID_WEIGHTS = new Set(['primary', 'corroborating', 'conflicting']);

// --- buildPrecedenceChain (pure) ---

test('buildPrecedenceChain: user-global first, project root→cwd (nearest-cwd last)', () => {
  const chain = buildPrecedenceChain('/a/b/c', '/home');
  assert.equal(chain[0].scope, 'user-global');
  assert.equal(chain[0].path, '/home/.claude/CLAUDE.md');
  const last = chain[chain.length - 1];
  assert.equal(last.scope, 'project');
  assert.equal(last.path, '/a/b/c/CLAUDE.md', 'cwd CLAUDE.md is highest-precedence (last)');
  // chain is bounded and reaches the root
  assert.ok(chain.some(c => c.path === '/CLAUDE.md'));
});

// --- classifyInstructionSurface (pure) ---

test('classify: PASS with a primary entry when ≥1 readable non-empty file', () => {
  const r = classifyInstructionSurface([
    { path: '/home/.claude/CLAUDE.md', scope: 'user-global', state: 'present' },
    { path: '/a/CLAUDE.md', scope: 'project', state: 'present' },
  ]);
  assert.equal(r.identity_status, 'PASS');
  assert.ok(r.evidence.some(e => e.weight === 'primary'));
});

test('classify: DEGRADED with a conflicting entry when a chain file is empty', () => {
  const r = classifyInstructionSurface([
    { path: '/home/.claude/CLAUDE.md', scope: 'user-global', state: 'present' },
    { path: '/a/CLAUDE.md', scope: 'project', state: 'empty' },
  ]);
  assert.equal(r.identity_status, 'DEGRADED');
  assert.ok(r.evidence.some(e => e.weight === 'conflicting'));
});

test('classify: NOT-YET when every file is absent', () => {
  const r = classifyInstructionSurface([
    { path: '/home/.claude/CLAUDE.md', scope: 'user-global', state: 'absent' },
    { path: '/a/CLAUDE.md', scope: 'project', state: 'absent' },
  ]);
  assert.equal(r.identity_status, 'NOT-YET');
});

test('classify: all evidence weights are schema-valid', () => {
  const states = [
    [{ path: 'x', scope: 'project', state: 'present' }],
    [{ path: 'x', scope: 'project', state: 'empty' }],
    [{ path: 'x', scope: 'project', state: 'absent' }],
  ];
  for (const s of states) for (const e of classifyInstructionSurface(s).evidence) {
    assert.ok(VALID_WEIGHTS.has(e.weight), `bad weight ${e.weight}`);
  }
});

// --- probe() integration against an isolated home/cwd ---

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'isr-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('probe: PASS row lists the resolved precedence chain', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home');
    const cwd = join(root, 'proj', 'sub');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# user global instructions');
    writeFileSync(join(cwd, 'CLAUDE.md'), '# project instructions');
    const row = await probe({ home, cwd });
    assert.equal(row.identity_status, 'PASS');
    assert.equal(row.capability_id, CAPABILITY_ID);
    assert.equal(row.schema_version, SCHEMA_VERSION);
    assert.equal(row.capability_kind, 'observation');
    assert.equal(row.mutation_permitted, false);
    assert.ok(Array.isArray(row.instruction_chain) && row.instruction_chain.length >= 2, 'chain lists resolved files');
    assert.ok(row.instruction_chain.some(c => c.scope === 'user-global'));
    assert.ok(row.instruction_chain.some(c => c.scope === 'project'));
  });
});

test('probe: NOT-YET when no CLAUDE.md anywhere in the chain', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home');
    const cwd = join(root, 'empty');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const row = await probe({ home, cwd });
    assert.equal(row.identity_status, 'NOT-YET');
  });
});

test('probe: DEGRADED when a chain file exists but is empty', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# present');
    writeFileSync(join(cwd, 'CLAUDE.md'), '   \n'); // whitespace-only = empty
    const row = await probe({ home, cwd });
    assert.equal(row.identity_status, 'DEGRADED');
  });
});

test('e2e: instruction-surface-resolution row flows through runStartup', async () => {
  const { runStartup } = await import('../../skills/core/scripts/capability-probe.mjs');
  const res = await runStartup({ harness: 'claude-code', cwd: '/work/Any' });
  const row = res.rows.find(r => r.capability_id === 'instruction-surface-resolution');
  assert.ok(row, 'runner emits the instruction-surface-resolution row for claude-code');
  assert.ok(['PASS', 'DEGRADED', 'NOT-YET', 'UNKNOWN'].includes(row.identity_status));
});
