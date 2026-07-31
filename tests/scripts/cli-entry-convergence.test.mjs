// CLI-entry convergence — two invariants for every script that moved onto the
// shared isCliEntry(import.meta.url) guard (cli-entry.mjs):
//
//   1. LIBRARY IMPORT IS INERT. Importing a converged script from another
//      module never runs its CLI main: no stdout, no stderr, exit 0, and no
//      files created in the working directory. This is the "identical
//      imported-library behavior" bar for the consolidation.
//
//   2. A SYMLINKED SPELLING IS STILL DIRECT EXECUTION. The pre-consolidation
//      defect class: one-sided canonicalization made `node <symlink-to-script>`
//      silently skip main() and exit 0. Through the shared helper, a symlinked
//      empty invocation behaves exactly like the direct empty invocation —
//      diagnostic on stderr, nonzero exit. Breaking the helper's
//      canonicalization turns these red (mutation-proven at review time).
//
// The representative set is small and stable on purpose: scripts whose empty
// invocation is a cheap, deterministic usage error with no environment needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');

const REPRESENTATIVES = [
  'maintenance-run.mjs',
  'generate-claude-md.mjs',
  'validate.mjs',
  'retrieve-context.mjs',
  'bm25.mjs',
  'index-registry.mjs',
];

function runNode(entry, cwd) {
  return spawnSync(process.execPath, [entry], {
    cwd, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd },
  });
}

for (const name of REPRESENTATIVES) {
  test(`${name} — importing as a library is inert (no output, no exit, no cwd writes)`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-entry-import-'));
    try {
      const href = new URL(`file://${join(SCRIPTS, name).replace(/\\/g, '/')}`).href;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(href)}); process.stdout.write('IMPORT_OK');`], {
        cwd, encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd },
      });
      assert.equal(r.status, 0, `import exited nonzero: ${r.stderr}`);
      assert.equal(r.stdout, 'IMPORT_OK', `import produced stdout beyond the sentinel: ${JSON.stringify(r.stdout)}`);
      assert.equal(r.stderr, '', `import produced stderr: ${JSON.stringify(r.stderr)}`);
      const leftover = readdirSync(cwd);
      assert.deepEqual(leftover, [], `import created files in cwd: ${leftover.join(', ')}`);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test(`${name} — a symlinked spelling still runs the CLI main (diagnostic + nonzero)`, {
    skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false,
  }, () => {
    const base = mkdtempSync(join(tmpdir(), 'cli-entry-link-'));
    try {
      const link = join(base, name);
      symlinkSync(join(SCRIPTS, name), link);
      const direct = runNode(join(SCRIPTS, name), base);
      const linked = runNode(link, base);
      assert.notEqual(direct.status, 0, `${name}: direct empty invocation is expected to be a usage error`);
      assert.notEqual(linked.status, 0,
        `${name} silently skipped its CLI main through a symlink (status 0, stderr ${JSON.stringify(linked.stderr)})`);
      assert.notEqual(linked.stderr, '', `${name} must explain the invalid empty invocation through a symlink`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
