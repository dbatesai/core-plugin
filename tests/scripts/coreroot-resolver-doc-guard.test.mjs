import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Guards for the CORE_ROOT resolver in protocols/startup.md. The resolver is
// prose-as-shell, so a regression is silent — and the regression that prompted
// this was catastrophic on Windows Git-Bash: a backslash
// regex inside a double-quoted `node -e` collapsed in the shell (\\ -> \),
// produced a compile-time SyntaxError try/catch could not catch, emptied
// CORE_ROOT, and resolved `node "/skills/..."` against the MSYS root.
//
// Three legs of honest coverage:
//   A. static doc-guard — the footgun pattern stays out, the guards stay in
//   B. live smoke — the ACTUAL resolver block from the doc runs under a fixture
//      HOME and resolves correctly (this leg would have caught the SyntaxError)
//   C. delegation guard — the block delegates to resolve-plugin-root.mjs
//      --print-root, with the env var demoted to script-locating only
// The Windows-Git-Bash leg is an on-box smoke; it cannot run on macOS CI.

const STARTUP = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins', 'core', 'skills', 'core', 'protocols', 'startup.md',
);
const md = readFileSync(STARTUP, 'utf8');

// Extract the first ```bash fenced block that contains the --print-root call —
// that's the resolver block: a single node call, no inline node -e.
function resolverBlock(src) {
  const blocks = [...src.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.includes('--print-root'));
  assert.ok(block, 'resolver bash block (with --print-root) found in startup.md');
  return block;
}

test('A1: resolver block contains no inline node -e payload (the Windows quoting footgun class)', () => {
  const block = resolverBlock(md);
  assert.ok(!block.includes('node -e'), 'no inline node -e — resolution lives in resolve-plugin-root.mjs');
  assert.ok(!block.includes('\\\\'), 'no escaped-backslash sequences in the block');
});

test('A2: no bash-only separator normalization remains (script normalizes)', () => {
  assert.ok(!md.includes('${CORE_ROOT//'), 'bash parameter-expansion swap removed from startup.md — --print-root prints forward slashes');
});

test('C1: resolver block delegates to --print-root with the env-var fallback for locating the script', () => {
  const block = resolverBlock(md);
  assert.match(block, /resolve-plugin-root\.mjs" --print-root/, 'primary --print-root call present');
  assert.match(block, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/core\/scripts\/resolve-plugin-root\.mjs/, 'env-var fallback locates the script, never asserts the root');
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

// ---- Leg B: live smoke. Run the ACTUAL resolver block under a fixture HOME,
// pre-substituting <PLUGIN_ROOT> the way the agent does from the SKILL.md header. ----

const REAL_RESOLVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'resolve-plugin-root.mjs',
);

function fixtureHome({ withScripts }) {
  const home = mkdtempSync(join(tmpdir(), 'coreroot-fixture-'));
  const installPath = join(home, 'install');
  if (withScripts) {
    const scriptsDir = join(installPath, 'skills', 'core', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(REAL_RESOLVER, join(scriptsDir, 'resolve-plugin-root.mjs'));
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
    writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'core', version: '0.0.0-fixture' }));
  } else {
    mkdirSync(installPath, { recursive: true });
  }
  return { home, installPath };
}

function runResolver(home, pluginRootSub) {
  const block = resolverBlock(md).replaceAll('<PLUGIN_ROOT>', pluginRootSub);
  const script = `${block}\nprintf 'RESULT:%s\\n' "$CORE_ROOT"`;
  return execFileSync('bash', ['-c', script], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

test('B1: substituted block resolves the install path via --print-root (no quoting failure)', () => {
  const { home, installPath } = fixtureHome({ withScripts: true });
  try {
    const out = runResolver(home, installPath);
    const real = realpathSync(installPath).replace(/\\/g, '/'); // resolve-plugin-root prints forward slashes on every platform
    assert.ok(out.includes(`CORE_ROOT=${real}`), `echoes resolved root; got:\n${out}`);
    assert.ok(out.includes(`RESULT:${real}`), `CORE_ROOT holds the install path; got:\n${out}`);
    assert.ok(!/SyntaxError/.test(out), 'no SyntaxError anywhere in resolution');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('B2: an unsubstituted/wrong PLUGIN_ROOT blanks CORE_ROOT and emits the loud marker', () => {
  const { home } = fixtureHome({ withScripts: false });
  try {
    const out = runResolver(home, join(home, 'install'));
    assert.ok(out.includes('CORE-ROOT-UNRESOLVED'), `emits unresolved marker; got:\n${out}`);
    assert.ok(/RESULT:\s*$/m.test(out), `CORE_ROOT is blank, not a wrong path; got:\n${out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

// M16 idiom lock — SCOPED to the skill entry-points that resolve CORE_ROOT
// themselves. These two each establish CORE_ROOT (finalize/process-memory via a
// "Script path resolution" preamble) and so MUST reference that resolved variable
// in their own command bodies — not ${CLAUDE_PLUGIN_ROOT}, which the same surfaces
// document as unreliable in Bash.
// validation.md and startup.md are the other two CORE_ROOT surfaces (covered by
// the doctrine test above + the resolver tests A1–B2).
//
// Deliberately OUT of scope: references/retrieval.md,
// references/hygiene-strategies.md, protocols/data-storage.md, scripts/README.md,
// and script header-comments still write ${CLAUDE_PLUGIN_ROOT} as a shorthand
// path-pointer. They carry no CORE_ROOT-resolution preamble of their own (they're
// sub-references the core skill loads AFTER startup resolved CORE_ROOT), so the
// env-var form is documentation shorthand there, not a runnable idiom mismatch.
// Whether to unify the whole tree on ${CORE_ROOT} is a separate, larger call.
test('M16: CORE_ROOT-resolving skills invoke scripts via ${CORE_ROOT}, not ${CLAUDE_PLUGIN_ROOT}', () => {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills');
  for (const rel of ['finalize/SKILL.md', 'process-memory/SKILL.md']) {
    const src = readFileSync(join(base, rel), 'utf8');
    assert.doesNotMatch(src, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/core\/scripts/,
      `${rel} command bodies must use \${CORE_ROOT}, not \${CLAUDE_PLUGIN_ROOT}`);
    assert.match(src, /\$\{CORE_ROOT\}\/skills\/core\/scripts/,
      `${rel} must invoke scripts via the resolved \${CORE_ROOT}`);
  }
});

// Sweep: hygiene.md commands and the register-sources path rule no longer
// lean on ${CLAUDE_PLUGIN_ROOT} as a primary source.
test('hygiene.md uses resolved CORE_ROOT; register-sources derives from the loaded path', () => {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills');
  const hygiene = readFileSync(join(base, 'core', 'protocols', 'hygiene.md'), 'utf8');
  assert.doesNotMatch(hygiene, /\$\{CLAUDE_PLUGIN_ROOT\}/, 'hygiene.md swept to ${CORE_ROOT}');
  const rs = readFileSync(join(base, 'register-sources', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(rs, /lives at `\$\{CLAUDE_PLUGIN_ROOT\}/, 'register-sources leads with loaded-path derivation, not the env var');
});
