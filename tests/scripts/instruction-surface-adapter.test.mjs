import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  inventorySurfaces, buildPlan, upsertCoreBlock, main, RESIDUALS, CORE_BLOCK_START, CORE_BLOCK_END,
} from '../../skills/core/scripts/instruction-surface-adapter.mjs';

// Recursive byte-snapshot of a directory tree (path -> sha256) for no-write proof.
function snapshot(dir) {
  const map = {};
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { map[p] = createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { map[p] = '<x>'; } }
    }
  })(dir);
  return map;
}

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'isa-'));
  const home = join(root, 'home');
  const cwd = join(home, 'proj');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# user global\n');
  writeFileSync(join(cwd, 'CLAUDE.md'), '# project instructions\n');
  // capture+silence stdout/stderr during main()
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '', err = '';
  process.stdout.write = (d) => { out += d; return true; };
  process.stderr.write = (d) => { err += d; return true; };
  const restore = () => { process.stdout.write = origOut; process.stderr.write = origErr; };
  try { return fn({ root, home, cwd, getOut: () => out, getErr: () => err, restore }); }
  finally { restore(); rmSync(root, { recursive: true, force: true }); }
}

test('inventory: includes user/project/.claude/local surfaces and managed-policy (not writable)', () => {
  const inv = inventorySurfaces({ cwd: '/a/b', home: '/home' });
  assert.ok(inv.some((s) => s.scope === 'user-global'));
  assert.ok(inv.some((s) => s.scope === 'project'));
  assert.ok(inv.some((s) => s.scope === 'project-claude-dir'));
  assert.ok(inv.some((s) => s.scope === 'local'));
  const mp = inv.find((s) => s.scope === 'managed-policy');
  assert.ok(mp && mp.writable === false, 'managed-policy is present and not writable');
});

test('buildPlan: dry-run, writes 0, proposed_content null, residuals name the NOT-YETs', () => {
  const plan = buildPlan(inventorySurfaces({ cwd: '/a/b', home: '/home' }));
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.writes, 0);
  assert.ok(plan.surfaces.every((s) => s.proposed_content === null));
  for (const r of ['content-generation-not-implemented', '@imports-not-resolved', 'excludes-not-resolved', '.claude/rules-not-resolved']) {
    assert.ok(plan.residuals.includes(r), `residual ${r} named`);
  }
});

test('dry-run default writes NOTHING — fixture home is byte-for-byte stable (HC_632)', () => {
  withFixture(({ home, cwd, restore }) => {
    const before = snapshot(home);
    const code = main(['--cwd', cwd, '--home', home]);
    const after = snapshot(home);
    restore();
    assert.equal(code, 0);
    assert.deepEqual(after, before, 'no file under the fixture home may change or appear after a dry-run');
  });
});

test('--apply refuses without an explicit target (exit 2, no write)', () => {
  withFixture(({ home, cwd, restore }) => {
    const before = snapshot(home);
    const code = main(['--apply', '--cwd', cwd, '--home', home]);
    const after = snapshot(home);
    restore();
    assert.equal(code, 2);
    assert.deepEqual(after, before);
  });
});

test('--apply refuses a managed-policy target (exit 2, no write)', () => {
  withFixture(({ home, cwd, restore }) => {
    const code = main(['--apply', '--target', '(managed-policy memory)', '--cwd', cwd, '--home', home]);
    restore();
    assert.equal(code, 2);
  });
});

test('--apply refuses a writable target too (content-generation not implemented; exit 2, no write)', () => {
  withFixture(({ home, cwd, restore }) => {
    const before = snapshot(home);
    const target = join(cwd, 'CLAUDE.md'); // a writable project surface
    const code = main(['--apply', '--target', target, '--cwd', cwd, '--home', home]);
    const after = snapshot(home);
    restore();
    assert.equal(code, 2, 'even a valid writable target refuses in this slice');
    assert.deepEqual(after, before, 'a refused --apply writes nothing');
  });
});

test('upsertCoreBlock: idempotent — replaces the CORE block, preserves human content', () => {
  const human = '# Human instructions\nkeep me\n';
  let c = upsertCoreBlock(human, 'core block v1');
  c = upsertCoreBlock(c, 'core block v2');
  const starts = c.split(CORE_BLOCK_START).length - 1;
  assert.equal(starts, 1, 'exactly one CORE block');
  assert.ok(c.includes('core block v2') && !c.includes('core block v1'), 'latest block content');
  assert.ok(c.includes('# Human instructions') && c.includes('keep me'), 'human content preserved');
  assert.ok(c.includes(CORE_BLOCK_END));
});
