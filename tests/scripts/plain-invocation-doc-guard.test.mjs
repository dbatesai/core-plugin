import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every CORE command the skill tells the agent to run is ONE plain
// `node <scripts>/<name>.mjs …` per Bash call. That shape is what a permission
// rule (and the skill's own `allowed-tools`) can match; the retired idiom —
// `[ -n "$CORE_ROOT" ] && node "${CORE_ROOT}/…" || echo MARKER` — could never
// match any rule, so every CORE call asked for approval (and the auto-mode
// classifier and user-written command gates refused it as unreadable).
// This guard keeps the shape from drifting back, file by file, line by line.

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills');

function mdFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'scripts' && e !== 'schemas' && e !== 'templates') out.push(...mdFiles(p)); }
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
}
const FILES = mdFiles(SKILLS);

function bashBlocks(src) {
  return [...src.matchAll(/```(?:bash|sh)\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

const SCRIPTS_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}/skills/core/scripts';
const RULE_ARGS = 'Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/*.mjs *)';
const RULE_BARE = 'Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/*.mjs)';

test('no shipped skill prose carries the retired CORE_ROOT resolver or guard idiom', () => {
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(SKILLS, f);
    assert.ok(!/\$\{?CORE_ROOT\}?/.test(src), `${rel}: $CORE_ROOT must not appear`);
    assert.ok(!/<CORE_ROOT>/.test(src), `${rel}: <CORE_ROOT> must not appear`);
    assert.ok(!/CORE-ROOT-UNRESOLVED/.test(src), `${rel}: the resolver marker is retired`);
    // the frontmatter allowed-tools rules legitimately carry the env-var form; commands in the body do not
    const body = src.replace(/^---\n[\s\S]*?\n---/, '');
    assert.ok(!/node "?\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/core\/scripts\//.test(body),
      `${rel}: commands are written as node <scripts>/…, not against the env var`);
  }
});

test('every bash block line is one plain command: no chaining, no variable, no redirect, no continuation', () => {
  let nodeLines = 0;
  for (const f of FILES) {
    const rel = relative(SKILLS, f);
    for (const block of bashBlocks(readFileSync(f, 'utf8'))) {
      for (const raw of block.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        assert.ok(!/&&|\|\||;|`|\$\(|\$\{|\$[A-Z_]/.test(line), `${rel}: chained or variable-bearing command: ${line}`);
        assert.ok(!/(^|\s)\d?>{1,2}\s|\s<\s|\s\|\s|2>&1/.test(line), `${rel}: pipe or redirect: ${line}`);
        assert.ok(!line.endsWith('\\'), `${rel}: line continuation: ${line}`);
        assert.ok(!/^(cd|export|if|then|else|fi|while|for)\b/.test(line), `${rel}: shell construct: ${line}`);
        assert.ok(!/^[A-Z_]+=/.test(line), `${rel}: assignment prefix defeats every Bash(node …) rule: ${line}`);
        if (line.startsWith('node ')) {
          nodeLines++;
          assert.match(line, /^node <scripts>\/[a-z0-9-]+\.mjs(\s|$)/, `${rel}: node call must be node <scripts>/<name>.mjs: ${line}`);
        }
      }
    }
  }
  assert.ok(nodeLines >= 60, `found the script call sites (${nodeLines})`);
});

test('the <scripts> placeholder is defined once, in core/SKILL.md, from the substituted plugin root', () => {
  const skill = readFileSync(join(SKILLS, 'core', 'SKILL.md'), 'utf8');
  assert.match(skill, /## Running CORE's scripts/);
  assert.ok(skill.includes(`\`${SCRIPTS_PLACEHOLDER}\``), 'SKILL.md names the scripts path via ${CLAUDE_PLUGIN_ROOT}, which the harness substitutes at load');
  assert.match(skill, /One `node <scripts>\/<name>\.mjs …` per Bash call/);
  const startup = readFileSync(join(SKILLS, 'core', 'protocols', 'startup.md'), 'utf8');
  assert.match(startup, /couldn't resolve the CORE plugin root/, 'an unresolved root is still surfaced in readiness, now via Cannot find module');
  assert.match(startup, /Never add `\|\| true`, `\|\| echo`, or `2>\/dev\/null`/);
});

test('every skill that runs CORE scripts pre-approves exactly that shape in allowed-tools', () => {
  for (const f of FILES.filter((p) => p.endsWith('SKILL.md'))) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('node <scripts>/')) continue;
    const fm = src.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
    const rel = relative(SKILLS, f);
    assert.ok(fm.includes(RULE_ARGS), `${rel}: allowed-tools carries ${RULE_ARGS}`);
    assert.ok(fm.includes(RULE_BARE), `${rel}: allowed-tools carries ${RULE_BARE} (a trailing " *" only covers the bare form when it is the rule's only wildcard)`);
    assert.ok(!/^\s*-\s*Bash\s*$/m.test(fm), `${rel}: no bare Bash grant — that is Bash(*) for the turn`);
  }
});
