import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  classifyAuthority,
  resolvePluginRoot,
} from '../../plugins/core/skills/core/scripts/resolve-plugin-root.mjs';

const RESOLVER = fileURLToPath(
  new URL('../../plugins/core/skills/core/scripts/resolve-plugin-root.mjs', import.meta.url),
);

// Build a plugins/core fixture with a chosen set of co-located manifests, and a
// real resolver copy at the script path so realpathSync(startingPath) succeeds
// (otherwise the unresolved-vs-resolved symlink mismatch on macOS, /tmp ->
// /private/tmp, manufactures a spurious env-reconciliation conflict that has
// nothing to do with what we're testing).
function withFixture(manifests, fn) {
  // realpath the base so env-var corroboration compares like-for-like paths.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-root-')));
  const pluginRoot = join(base, 'plugins', 'core');
  const scriptsDir = join(pluginRoot, 'skills', 'core', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  if (manifests.includes('codex')) {
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'core', version: '3.1.0' }));
  }
  if (manifests.includes('claude')) {
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'core', version: '3.1.0' }));
  }
  const from = join(scriptsDir, 'resolve-plugin-root.mjs');
  copyFileSync(RESOLVER, from);
  try {
    return fn({ pluginRoot, from });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const claudeEnv = (root) => ({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_CODE_SESSION_ID: 's' });
const codexEnv = (root) => ({ CODEX_PLUGIN_ROOT: root, CODEX_THREAD_ID: 't' });

// ---------- Finding 1: classifyAuthority separator handling (Windows) ----------
// On Windows homedir() returns a backslash path; the bucket literals use forward
// slashes. Before the fix the interpolated comparison string was mixed-separator
// and matched nothing, so every Windows path classified as 'unknown' and every
// mutation gate failed closed for Windows users (Meridian, issue #45).

test('classifyAuthority: Windows backslash installed-cache classifies (not unknown)', () => {
  const home = 'C:\\Users\\david';
  const root = 'C:\\Users\\david\\.claude\\plugins\\cache\\core\\core\\3.1.0';
  assert.equal(classifyAuthority(root, home), 'installed-cache');
});

test('classifyAuthority: Windows backslash codex cache classifies', () => {
  const home = 'C:\\Users\\david';
  const root = 'C:\\Users\\david\\.codex\\plugins\\cache\\core\\core\\3.1.0';
  assert.equal(classifyAuthority(root, home), 'installed-cache');
});

test('classifyAuthority: Windows backslash canonical-source classifies', () => {
  const home = 'C:\\Users\\david';
  const root = 'C:\\Users\\david\\Documents\\Projects\\core-plugin';
  assert.equal(classifyAuthority(root, home), 'canonical-source');
});

test('classifyAuthority: POSIX paths still classify after normalization', () => {
  assert.equal(classifyAuthority('/Users/dbates/.claude/plugins/cache/core/core/3.1.0', '/Users/dbates'), 'installed-cache');
  assert.equal(classifyAuthority('/Users/dbates/Documents/Projects/core-plugin', '/Users/dbates'), 'canonical-source');
});

test('classifyAuthority: unrecognized location still fails closed to unknown', () => {
  assert.equal(classifyAuthority('/opt/random/place', '/Users/dbates'), 'unknown');
  assert.equal(classifyAuthority('C:\\Temp\\random', 'C:\\Users\\david'), 'unknown');
});

// ---------- HARNESS-010: common Windows dev paths must classify, not fail closed ----------

test('classifyAuthority: Visual Studio default source\\repos classifies as canonical-source', () => {
  assert.equal(
    classifyAuthority('C:\\Users\\david\\source\\repos\\core-plugin', 'C:\\Users\\david'),
    'canonical-source');
});

test('classifyAuthority: home-level Projects and repos dirs classify', () => {
  assert.equal(classifyAuthority('C:\\Users\\david\\Projects\\core-plugin', 'C:\\Users\\david'), 'canonical-source');
  assert.equal(classifyAuthority('C:\\Users\\david\\repos\\core-plugin', 'C:\\Users\\david'), 'canonical-source');
  assert.equal(classifyAuthority('/Users/dbates/Projects/core-plugin', '/Users/dbates'), 'canonical-source');
});

test('classifyAuthority: drive-root dev dirs classify (C:\\repos, D:\\dev, C:\\src)', () => {
  assert.equal(classifyAuthority('C:\\repos\\core-plugin', 'C:\\Users\\david'), 'canonical-source');
  assert.equal(classifyAuthority('D:\\dev\\core-plugin', 'C:\\Users\\david'), 'canonical-source');
  assert.equal(classifyAuthority('C:\\src\\core-plugin', 'C:\\Users\\david'), 'canonical-source');
});

test('classifyAuthority: still fails closed outside recognized locations', () => {
  assert.equal(classifyAuthority('C:\\Windows\\Temp\\x', 'C:\\Users\\david'), 'unknown');
  assert.equal(classifyAuthority('E:\\games\\mods\\thing', 'C:\\Users\\david'), 'unknown');
});

// ---------- Finding 2: co-located multi-harness re-point ----------
// The collapsed plugins/core/ layout co-locates .codex-plugin and .claude-plugin
// in one dir. findPluginRootAnchor is codex-first-match-wins, so without the
// re-point a Claude session resolved manifest_harness=codex, tripped the
// step-6.5(b) split-brain check, and DEGRADED on every resolution (Meridian #45).

test('co-located manifests + Claude env -> PASS (re-points to claude-code)', () => {
  withFixture(['codex', 'claude'], ({ pluginRoot, from }) => {
    const r = resolvePluginRoot({ from, env: claudeEnv(pluginRoot), home: '/Users/dbates' });
    assert.equal(r.identity_status, 'PASS');
    assert.equal(r.manifest_harness, 'claude-code');
    assert.equal(r.consuming_harness, 'claude-code');
    assert.ok(r.evidence.some(e => e.source === 'co-located-manifest-repoint'),
      'expected a co-located-manifest-repoint evidence entry');
    assert.ok(!r.evidence.some(e => e.source === 'harness-split-brain'),
      'split-brain must not fire on a co-located root');
  });
});

test('co-located manifests + Codex env -> PASS (codex anchor already wins)', () => {
  withFixture(['codex', 'claude'], ({ pluginRoot, from }) => {
    const r = resolvePluginRoot({ from, env: codexEnv(pluginRoot), home: '/Users/dbates' });
    assert.equal(r.identity_status, 'PASS');
    assert.equal(r.manifest_harness, 'codex');
    assert.equal(r.consuming_harness, 'codex');
  });
});

// Regression guards: re-point must NOT over-broaden. When only the OTHER
// harness's manifest is present, we walked to a plugin that doesn't serve the
// running harness — a genuine wrong-plugin split-brain that must still DEGRADE.

test('codex-only manifest + Claude env -> DEGRADED (genuine wrong-plugin)', () => {
  withFixture(['codex'], ({ pluginRoot, from }) => {
    const r = resolvePluginRoot({ from, env: claudeEnv(pluginRoot), home: '/Users/dbates' });
    assert.equal(r.identity_status, 'DEGRADED');
    assert.equal(r.manifest_harness, 'codex');
    assert.equal(r.consuming_harness, 'claude-code');
    assert.ok(r.evidence.some(e => e.source === 'harness-split-brain'),
      'split-brain MUST fire when the consuming harness manifest is absent');
    assert.ok(!r.evidence.some(e => e.source === 'co-located-manifest-repoint'),
      'no re-point when the consuming harness manifest is absent');
  });
});

test('claude-only manifest + Codex env -> DEGRADED (genuine wrong-plugin)', () => {
  withFixture(['claude'], ({ pluginRoot, from }) => {
    const r = resolvePluginRoot({ from, env: codexEnv(pluginRoot), home: '/Users/dbates' });
    assert.equal(r.identity_status, 'DEGRADED');
    assert.equal(r.manifest_harness, 'claude-code');
    assert.equal(r.consuming_harness, 'codex');
    assert.ok(r.evidence.some(e => e.source === 'harness-split-brain'));
  });
});

test('co-located + WEAK Claude signal (session id only) -> PASS — mirrors Windows-bash', () => {
  // Meridian's on-box Windows harness injects only CLAUDE_CODE_SESSION_ID, not
  // the strong CLAUDE_PLUGIN_ROOT — the weak signal is still enough to set
  // consuming_harness=claude-code and trip the pre-fix split-brain. This pins
  // the exact scenario she re-runs.
  withFixture(['codex', 'claude'], ({ from }) => {
    const r = resolvePluginRoot({ from, env: { CLAUDE_CODE_SESSION_ID: 's' }, home: '/Users/dbates' });
    assert.equal(r.identity_status, 'PASS');
    assert.equal(r.manifest_harness, 'claude-code');
    assert.equal(r.consuming_harness, 'claude-code');
    assert.ok(r.evidence.some(e => e.source === 'co-located-manifest-repoint'));
  });
});

test('re-point makes Step 4 corroborate the consuming harness env var', () => {
  // The core reason to re-point (not just silence 6.5b): manifest_harness=codex
  // would send Step 4 looking for CODEX_PLUGIN_ROOT, find null, and skip — so the
  // real CLAUDE_PLUGIN_ROOT signal never gets checked against the resolved root.
  withFixture(['codex', 'claude'], ({ pluginRoot, from }) => {
    const r = resolvePluginRoot({ from, env: claudeEnv(pluginRoot), home: '/Users/dbates' });
    const envEvidence = r.evidence.find(e => e.source === 'env-var-CLAUDE_PLUGIN_ROOT');
    assert.ok(envEvidence, 'CLAUDE_PLUGIN_ROOT should be reconciled after re-point');
    assert.equal(envEvidence.weight, 'corroborating');
  });
});

import { execFileSync } from 'node:child_process';

// ---------- SYN-002: --print-root (single cross-shell CORE_ROOT source) ----------
// startup.md's resolver block delegates to `node resolve-plugin-root.mjs
// --print-root` instead of bash-only parameter expansion. Contract: print
// exactly one line — the plugin root with forward slashes — and exit 0; or
// print nothing to stdout, a CORE-ROOT-UNRESOLVED marker to stderr, exit 2.

test('--print-root prints the plugin root on one line and exits 0', () => {
  withFixture(['codex', 'claude'], ({ pluginRoot, from }) => {
    const out = execFileSync(process.execPath, [from, '--print-root'], { encoding: 'utf8' });
    assert.equal(out.trim(), pluginRoot.replace(/\\/g, '/'));
  });
});

test('--print-root output contains no backslashes (bash/PowerShell/Git-Bash safe)', () => {
  withFixture(['claude'], ({ from }) => {
    const out = execFileSync(process.execPath, [from, '--print-root'], { encoding: 'utf8' });
    assert.ok(!out.includes('\\'), 'separators normalized to forward slashes');
  });
});

test('--print-root still prints the root when identity is DEGRADED (location is knowable)', () => {
  // codex-only manifest + Claude env = split-brain DEGRADED, but the root
  // location itself is unambiguous; startup needs the path either way.
  withFixture(['codex'], ({ pluginRoot, from }) => {
    const out = execFileSync(process.execPath, [from, '--print-root'],
      { encoding: 'utf8', env: { ...process.env, ...claudeEnv(pluginRoot) } });
    assert.equal(out.trim(), pluginRoot.replace(/\\/g, '/'));
  });
});

test('--print-root with no anchor above prints nothing to stdout and exits 2', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'print-root-none-')));
  try {
    const from = join(base, 'resolve-plugin-root.mjs');
    copyFileSync(RESOLVER, from);
    let code = 0, stdout = '';
    try {
      stdout = execFileSync(process.execPath, [from, '--print-root'], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      stdout = e.stdout;
    }
    assert.equal(code, 2, 'unresolved root exits 2');
    assert.equal(stdout.trim(), '', 'nothing on stdout when unresolved');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
