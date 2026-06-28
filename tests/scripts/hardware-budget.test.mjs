import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyHardware } from '../../plugins/core/skills/core/scripts/hardware-budget.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../plugins/core/skills/core/scripts/hardware-budget.mjs', import.meta.url),
);

const GB = 1024 ** 3;

test('classifyHardware: thresholds mirror execution.md §Hardware budget', () => {
  assert.deepEqual(classifyHardware(64 * GB), { gb: 64, profile: 'Context Hoarder', max_agents: 8 });
  assert.deepEqual(classifyHardware(48 * GB), { gb: 48, profile: 'Context Hoarder', max_agents: 8 });
  assert.deepEqual(classifyHardware(32 * GB), { gb: 32, profile: 'Streamlined Thinker', max_agents: 5 });
  assert.deepEqual(classifyHardware(24 * GB), { gb: 24, profile: 'Streamlined Thinker', max_agents: 5 });
  assert.deepEqual(classifyHardware(16 * GB), { gb: 16, profile: 'Minimal Mode', max_agents: 3 });
  assert.deepEqual(classifyHardware(8 * GB),  { gb: 8,  profile: 'Minimal Mode', max_agents: 3 });
});

test('CLI prints one machine-readable line and exits 0 on every platform', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /^memory_gb=\d+ profile=[a-z-]+ max_agents=\d+\n$/,
    'single-line key=value output');
});
