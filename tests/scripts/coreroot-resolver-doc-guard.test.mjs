import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Guards for the CORE_ROOT resolver in protocols/startup.md. The resolver is
// prose-as-shell, so a regression is silent — and the regression that prompted
// this (Meridian, 2026-05-31) was catastrophic on Windows Git-Bash: a backslash
// regex inside a double-quoted `node -e` collapsed in the shell (\\ -> \),
// produced a compile-time SyntaxError try/catch could not catch, emptied
// CORE_ROOT, and resolved `node "/skills/..."` against the MSYS root.
//
// Three legs of honest coverage:
//   A. static doc-guard — the footgun pattern stays out, the guards stay in
//   B. live smoke — the ACTUAL resolver block from the doc runs under a fixture
//      HOME and resolves correctly (this leg would have caught the SyntaxError)
//   C. transform unit — the bash separator swap turns backslashes into slashes
// The Windows-Git-Bash leg is Meridian's on-box smoke; it cannot run on macOS CI.

const STARTUP = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins', 'core', 'skills', 'core', 'protocols', 'startup.md',
);
const md = readFileSync(STARTUP, 'utf8');

// Extract the first ```bash fenced block that contains the installed_plugins.json
// fallback — that's the resolver block.
function resolverBlock(src) {
  const blocks = [...src.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.includes('installed_plugins.json'));
  assert.ok(block, 'resolver bash block (with installed_plugins.json) found in startup.md');
  return block;
}

// Isolate the `node -e "..."` payload from the resolver block.
function nodePayload(block) {
  const m = block.match(/node -e "([\s\S]*?)"\s*\)/);
  assert.ok(m, 'node -e payload found in resolver block');
  return m[1];
}

test('A1: resolver node -e payload contains no backslash (the exact Windows footgun)', () => {
  const payload = nodePayload(resolverBlock(md));
  assert.ok(
    !payload.includes('\\'),
    'no backslash may appear inside the double-quoted node -e payload — it collapses in-shell and SyntaxErrors',
  );
  assert.ok(
    !/replace\(\//.test(payload),
    'no regex-replace separator swap inside node -e — do the swap in bash instead',
  );
});

test('A2: separator normalization happens in bash, not node', () => {
  const block = resolverBlock(md);
  assert.ok(
    block.includes('${CORE_ROOT//\\\\//}'),
    'bash parameter-expansion separator swap (${CORE_ROOT//\\\\//}) is present',
  );
});

test('A3: the structural gate and loud marker are present', () => {
  const block = resolverBlock(md);
  assert.ok(
    block.includes('[ -d "$CORE_ROOT/skills/core/scripts" ]'),
    'scripts-dir existence gate present',
  );
  assert.ok(
    block.includes('CORE-ROOT-UNRESOLVED'),
    'structured unresolved marker emitted on failure',
  );
  assert.ok(
    /CORE_ROOT=""/.test(block),
    'CORE_ROOT is explicitly blanked on failure so downstream guards skip cleanly',
  );
});

test('A4: every node "${CORE_ROOT}/..." call site is mechanically guarded', () => {
  // No bare invocation may sit at the start of a line / after && without a
  // preceding scripts-dir or non-empty guard. We check each call line has a
  // guard token on the same logical command.
  const lines = md.split('\n');
  const callLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /node "\$\{CORE_ROOT\}\/skills\/core\/scripts\//.test(l));
  assert.ok(callLines.length >= 3, 'found the script call sites');
  for (const { l, i } of callLines) {
    // The call is guarded if the same line or the line above carries a guard:
    // a `[ -d ... ]` / `[ -n "$CORE_ROOT" ]` test, or it's inside the Step-8
    // table (which is gated by an explicit "Gate first" instruction) or the
    // capability block (prose-gated + `|| true`).
    const window = [lines[i - 1] || '', l].join('\n');
    const guarded =
      /\[ -d "\$CORE_ROOT\/skills\/core\/scripts" \]/.test(window) ||
      /\[ -n "\$CORE_ROOT" \]/.test(window) ||
      l.includes('| `node') ||           // Step-8 markdown table row (gated above the table)
      /2>\/dev\/null/.test(window) ||     // capability block, fail-open with || true
      /capability-probe|record-capability-snapshot/.test(l);
    assert.ok(guarded, `call site is guarded: ${l.trim().slice(0, 80)}`);
  }
});

test('A5: readiness surfacing for an unresolved root is loud, not silent', () => {
  assert.ok(
    /couldn't resolve the CORE plugin root/.test(md),
    'readiness receipt surfaces an unresolved CORE_ROOT to the user',
  );
});

// ---- Leg B: live smoke. Run the ACTUAL resolver block under a fixture HOME. ----

function fixtureHome({ installSubdir, withScripts }) {
  const home = mkdtempSync(join(tmpdir(), 'coreroot-fixture-'));
  const installPath = join(home, installSubdir);
  if (withScripts) {
    mkdirSync(join(installPath, 'skills', 'core', 'scripts'), { recursive: true });
    // The resolver's tier-2 `-f workspace-fork-check.mjs` check is bypassed
    // (we force tier 3), but the final `-d scripts` gate must see a real dir.
    writeFileSync(join(installPath, 'skills', 'core', 'scripts', 'workspace-fork-check.mjs'), '// fixture\n');
  } else {
    mkdirSync(installPath, { recursive: true });
  }
  const pluginsDir = join(home, '.claude', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const manifest = {
    plugins: { 'core@core': [{ scope: 'user', installPath }] },
  };
  writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify(manifest));
  return { home, installPath };
}

// Run the resolver block verbatim, forcing tier 3 (literal <PLUGIN_ROOT> won't
// exist, CLAUDE_PLUGIN_ROOT unset), and echo the final CORE_ROOT state.
function runResolver(home) {
  const block = resolverBlock(md);
  const script = `${block}\nprintf 'RESULT:%s\\n' "$CORE_ROOT"`;
  return execFileSync('bash', ['-c', script], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

test('B1: resolver block executes under a fixture (no SyntaxError) and resolves the install path', () => {
  const { home, installPath } = fixtureHome({ installSubdir: 'install', withScripts: true });
  try {
    const out = runResolver(home);
    assert.ok(out.includes(`CORE_ROOT=${installPath}`), `echoes resolved root; got:\n${out}`);
    assert.ok(out.includes(`RESULT:${installPath}`), `CORE_ROOT holds the install path; got:\n${out}`);
    assert.ok(!/SyntaxError/.test(out), 'no SyntaxError from the node payload');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('B2: a missing scripts dir blanks CORE_ROOT and emits the loud marker (skip-and-surface)', () => {
  const { home } = fixtureHome({ installSubdir: 'install', withScripts: false });
  try {
    const out = runResolver(home);
    assert.ok(out.includes('CORE-ROOT-UNRESOLVED'), `emits unresolved marker; got:\n${out}`);
    assert.ok(/RESULT:\s*$/m.test(out), `CORE_ROOT is blank, not a wrong path; got:\n${out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Leg C: the bash separator swap, in isolation. ----

test('C1: bash ${//\\//} converts backslashes to forward slashes', () => {
  // Build the backslash path at runtime so the shell never sees a literal one
  // in the test source either.
  const script = 'p="C:$(printf \'\\\\\')Users$(printf \'\\\\\')x"; printf \'%s\' "${p//\\\\//}"';
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(out, 'C:/Users/x', 'backslashes normalized to forward slashes by bash');
});

// M16: finalize/process-memory/validation must agree with startup.md that
// ${CLAUDE_PLUGIN_ROOT} is NOT reliably injected into Bash calls, and resolve the
// root from the loaded skill path instead. The old prose ("set on Claude Code
// marketplace installs") contradicted startup and assumed the var was present.
test('M16: skill surfaces do not claim CLAUDE_PLUGIN_ROOT is reliably set, and defer to the startup resolver', () => {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills');
  for (const rel of ['finalize/SKILL.md', 'process-memory/SKILL.md']) {
    const src = readFileSync(join(base, rel), 'utf8');
    assert.doesNotMatch(src, /env var is set on Claude Code marketplace installs/,
      `${rel} must not assert the env var is reliably set`);
    assert.match(src, /not reliably injected into agent Bash tool calls/,
      `${rel} must state the env var is unreliable in Bash calls (agrees with startup.md)`);
  }
  const validation = readFileSync(join(base, 'core', 'protocols', 'validation.md'), 'utf8');
  assert.match(validation, /not reliably injected into agent Bash tool calls/,
    'validation.md must agree the env var is unreliable and defer to the startup resolver');
});
