import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { writeMarketplaceRegistration } = await import(pathToFileURL(join(PILOT, 'plugin-registration.mjs')).href);

// The real worktree root (this pilot's own candidate repo) genuinely has a
// .claude-plugin/marketplace.json -- verified on disk before writing the
// module. Used as the real, valid candidateRepoRoot in tests.
const REAL_REPO_ROOT = join(PILOT, '..');

function tmpHome() { return mkdtempSync(join(tmpdir(), 'reg-home-')); }
function fakeRepoWithoutMarketplace() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-repo-'));
  return dir; // deliberately has no .claude-plugin/marketplace.json
}

test('writes extraKnownMarketplaces + enabledPlugins in the real project shape', () => {
  const home = tmpHome();
  try {
    const { settingsPath, key } = writeMarketplaceRegistration(home, { marketplaceName: 'core-pilot-test', candidateRepoRoot: REAL_REPO_ROOT });
    assert.equal(key, 'core@core-pilot-test');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.extraKnownMarketplaces['core-pilot-test'], { source: { source: 'directory', path: REAL_REPO_ROOT } });
    assert.equal(settings.enabledPlugins['core@core-pilot-test'], true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('preserves unrelated existing settings.json content, never clobbers it', () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365, permissions: { allow: ['Bash(*)'] } }));
    writeMarketplaceRegistration(home, { marketplaceName: 'core-pilot-test', candidateRepoRoot: REAL_REPO_ROOT });
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.cleanupPeriodDays, 365, 'unrelated top-level key must survive');
    assert.deepEqual(settings.permissions, { allow: ['Bash(*)'] }, 'unrelated nested key must survive');
    assert.equal(settings.enabledPlugins['core@core-pilot-test'], true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('registering twice is idempotent, not duplicated or corrupted', () => {
  const home = tmpHome();
  try {
    writeMarketplaceRegistration(home, { marketplaceName: 'core-pilot-test', candidateRepoRoot: REAL_REPO_ROOT });
    writeMarketplaceRegistration(home, { marketplaceName: 'core-pilot-test', candidateRepoRoot: REAL_REPO_ROOT });
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(Object.keys(settings.extraKnownMarketplaces).length, 1);
    assert.equal(Object.keys(settings.enabledPlugins).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a second, distinctly-named registration coexists alongside the first', () => {
  const home = tmpHome();
  try {
    writeMarketplaceRegistration(home, { marketplaceName: 'core-pilot-a', candidateRepoRoot: REAL_REPO_ROOT });
    writeMarketplaceRegistration(home, { marketplaceName: 'core-pilot-b', candidateRepoRoot: REAL_REPO_ROOT });
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(Object.keys(settings.extraKnownMarketplaces).length, 2);
    assert.equal(Object.keys(settings.enabledPlugins).length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('refuses to register a candidateRepoRoot with no .claude-plugin/marketplace.json', () => {
  const home = tmpHome();
  const fakeRepo = fakeRepoWithoutMarketplace();
  try {
    assert.throws(
      () => writeMarketplaceRegistration(home, { marketplaceName: 'x', candidateRepoRoot: fakeRepo }),
      (e) => e.code === 'REPO_MARKETPLACE_JSON_MISSING',
    );
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(fakeRepo, { recursive: true, force: true }); }
});

test('refuses a malformed pre-existing settings.json instead of silently overwriting it', () => {
  const home = tmpHome();
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), 'not valid json {{{');
    assert.throws(
      () => writeMarketplaceRegistration(home, { marketplaceName: 'x', candidateRepoRoot: REAL_REPO_ROOT }),
      (e) => e.code === 'SETTINGS_JSON_MALFORMED',
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('requires homeDir, marketplaceName, and candidateRepoRoot', () => {
  const home = tmpHome();
  try {
    assert.throws(() => writeMarketplaceRegistration('/does/not/exist', { marketplaceName: 'x', candidateRepoRoot: REAL_REPO_ROOT }), (e) => e.code === 'HOME_DIR_MISSING');
    assert.throws(() => writeMarketplaceRegistration(home, { candidateRepoRoot: REAL_REPO_ROOT }), (e) => e.code === 'MARKETPLACE_NAME_REQUIRED');
    assert.throws(() => writeMarketplaceRegistration(home, { marketplaceName: 'x' }), (e) => e.code === 'CANDIDATE_REPO_ROOT_REQUIRED');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
