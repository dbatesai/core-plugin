import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateForHarness, HARNESS_OUTPUT } from '../../plugins/core/skills/core/scripts/contract-format.mjs';
import { generate } from '../../plugins/core/skills/core/scripts/generate-harness-md.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-harness-md.mjs', import.meta.url));
const FORMAT_URL = new URL('../../plugins/core/skills/core/scripts/contract-format.mjs', import.meta.url).href;
const CONTRACT = `---
schema_version: "1.0"
contract_id: preservation-test
canonical_for: [claude-code, codex]
last_revised: 2026-10-02
---

## Project Overview

Generated project instructions.
`;

function fixture(harness) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-preservation-'));
  const contractPath = join(dir, 'CONTRACT.md');
  const outputPath = join(dir, HARNESS_OUTPUT[harness]);
  writeFileSync(contractPath, CONTRACT);
  return { dir, contractPath, outputPath, harness, mode: 'write' };
}

for (const harness of Object.keys(HARNESS_OUTPUT)) {
  for (const [name, writer] of [['shared writer', generateForHarness], ['public wrapper', generate]]) {
    test(`${name} refuses hand-authored ${HARNESS_OUTPUT[harness]} and preserves exact bytes`, async () => {
      const f = fixture(harness);
      try {
        const authored = '# Human instructions\r\n\r\nDo not erase this rule.\r\n';
        writeFileSync(f.outputPath, authored);
        await assert.rejects(writer(f), { code: 'EEXIST' });
        assert.equal(readFileSync(f.outputPath, 'utf8'), authored);
        assert.deepEqual(readdirSync(f.dir).sort(), ['CONTRACT.md', HARNESS_OUTPUT[harness]].sort());
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
  }

  test(`explicit replacement is required and sufficient for ${HARNESS_OUTPUT[harness]}`, async () => {
    const f = fixture(harness);
    try {
      writeFileSync(f.outputPath, 'Human instructions.\n');
      await assert.rejects(generate({ ...f, replaceExisting: 'true' }), { code: 'EEXIST' });
      const result = await generate({ ...f, replaceExisting: true });
      assert.equal(result.written, f.outputPath);
      assert.match(readFileSync(f.outputPath, 'utf8'), /GENERATED FROM CONTRACT — DO NOT EDIT BY HAND/);
      writeFileSync(f.contractPath, CONTRACT.replace('Generated project instructions.', 'Updated project instructions.'));
      await generate(f); // An owned generated output may refresh without replacement permission.
      assert.match(readFileSync(f.outputPath, 'utf8'), /Updated project instructions/);
      assert.deepEqual(readdirSync(f.dir).sort(), ['CONTRACT.md', HARNESS_OUTPUT[harness]].sort());
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test(`CLI refuses authored ${HARNESS_OUTPUT[harness]} unless --replace-existing is present`, () => {
    const f = fixture(harness);
    try {
      const authored = '# Human instructions\nLeave this alone.\n';
      writeFileSync(f.outputPath, authored);
      const args = [SCRIPT, '--harness', harness, '--contract', f.contractPath, '--mode', 'write'];
      const refused = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /hand-authored|not generated/);
      assert.match(refused.stderr, /--replace-existing/);
      assert.doesNotMatch(refused.stderr, /\n\s+at /, 'bounded diagnostic, no stack trace');
      assert.equal(readFileSync(f.outputPath, 'utf8'), authored);
      const replaced = spawnSync(process.execPath, [...args, '--replace-existing'], { encoding: 'utf8' });
      assert.equal(replaced.status, 0, replaced.stderr);
      assert.match(readFileSync(f.outputPath, 'utf8'), /Generated project instructions/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('dry-run and check never modify authored output, including with replacement permission', async () => {
  const f = fixture('codex');
  try {
    writeFileSync(f.outputPath, 'Human instructions.\n');
    const dry = await generate({ ...f, mode: 'dry-run', replaceExisting: true });
    const checked = await generate({ ...f, mode: 'check', replaceExisting: true });
    assert.match(dry.wouldWrite, /Generated project instructions/);
    assert.equal(checked.drift, true);
    assert.equal(readFileSync(f.outputPath, 'utf8'), 'Human instructions.\n');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const failure of ['write', 'rename']) {
  test(`atomic harness replacement preserves old bytes and cleans temp files after a ${failure} failure`, async () => {
    const f = fixture('codex');
    try {
      await generate(f);
      const original = readFileSync(f.outputPath, 'utf8');
      writeFileSync(f.contractPath, CONTRACT.replace('Generated project instructions.', 'Changed content.'));
      // Inject at the real fs boundary in an isolated child. A direct/truncating writer
      // either corrupts the target (write failure) or misses the rename oracle entirely.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import assert from 'node:assert/strict';
        const outputPath = ${JSON.stringify(f.outputPath)};
        const originalWrite = fs.writeFileSync;
        if (${JSON.stringify(failure)} === 'write') {
          fs.writeFileSync = function(path, data, options) {
            originalWrite(path, String(data).slice(0, 7), options);
            throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
          };
        } else {
          fs.renameSync = function() { throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); };
        }
        syncBuiltinESMExports();
        const { generateForHarness } = await import(${JSON.stringify(FORMAT_URL)});
        await assert.rejects(generateForHarness(${JSON.stringify(f)}), { code: ${JSON.stringify(failure === 'write' ? 'ENOSPC' : 'EIO')} });
        assert.equal(fs.readFileSync(outputPath, 'utf8'), ${JSON.stringify(original)});
      `], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(f.outputPath, 'utf8'), original);
      assert.deepEqual(readdirSync(f.dir).sort(), ['AGENTS.md', 'CONTRACT.md']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}
