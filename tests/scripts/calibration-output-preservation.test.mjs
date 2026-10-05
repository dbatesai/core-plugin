import {realpathSync} from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportWorksheet, importLabels } from '../../plugins/core/skills/core/scripts/calibrate-classifier.mjs';
import { CLASSIFIER_VERSION, PROXY_VERSION } from '../../plugins/core/skills/core/scripts/classify-turns.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/calibrate-classifier.mjs', import.meta.url));
const CALIBRATION_URL = new URL('../../plugins/core/skills/core/scripts/calibrate-classifier.mjs', import.meta.url).href;
const METRICS_URL = new URL('../../plugins/core/skills/core/scripts/log-event.mjs', import.meta.url).href;
const row = harness => ({
  classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION,
  harness, session_id: 'synthetic-session', turn_idx: 1, state: 'tier-0-win',
  turn_evidence: { user_text: 'Synthetic request.', assistant_text: 'Synthetic answer.' },
});

function fixture(t, harness = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'calibration-preservation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const classifiedDir = join(dir, 'classified');
  mkdirSync(classifiedDir);
  writeFileSync(join(classifiedDir, '2026-10-02.jsonl'), JSON.stringify(row(harness)) + '\n');
  const options = { project: dir, harness, classifiedDir, calibrationDir: join(dir, 'calibration'), today: '2026-10-02' };
  const first = exportWorksheet(options);
  assert.equal(first.status, 'OK');
  return { dir, options, first };
}

function annotate(path, fields) {
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  Object.assign(rows[0], fields);
  writeFileSync(path, rows.map(JSON.stringify).join('\n') + '\n');
}

const artifactPaths = result => [result.jsonl_path, result.predictions_path, result.md_path];
const snapshot = result => artifactPaths(result).map(path => readFileSync(path, 'utf8'));

for (const harness of ['claude-code', 'codex']) {
  for (const fields of [
    { gold_state: 'capture-miss' },
    { labelers: ['human-a'] },
    { adjudicated_by: 'human-b' },
    { confidence: 'low' },
    { labeler: 'legacy-human' },
  ]) {
    test(`same-day ${harness} export preserves ${Object.keys(fields)[0]} and all companion bytes`, t => {
      const { options, first } = fixture(t, harness);
      annotate(first.jsonl_path, fields);
      const before = snapshot(first);
      const result = exportWorksheet(options);
      assert.equal(result.status, 'ERROR');
      assert.equal(result.error_code, 'worksheet-has-labels');
      assert.match(result.message, /--replace-existing/);
      assert.deepEqual(snapshot(first), before, 'no worksheet, prediction nonce, or guide may change on refusal');
    });
  }
}

test('explicit replacement resets labels while making a valid new blind prediction pair', t => {
  const { options, first, dir } = fixture(t);
  annotate(first.jsonl_path, { gold_state: 'capture-miss', labelers: ['human-a', 'human-b'], adjudicated_by: 'human-c', confidence: 'high' });
  const labeled = snapshot(first);
  assert.equal(exportWorksheet({ ...options, replaceExisting: 'true' }).status, 'ERROR', 'truthy strings do not approve replacement');
  assert.deepEqual(snapshot(first), labeled);
  const result = exportWorksheet({ ...options, replaceExisting: true });
  assert.equal(result.status, 'OK');
  const fresh = JSON.parse(readFileSync(result.jsonl_path, 'utf8').trim());
  assert.equal(fresh.gold_state, null);
  assert.deepEqual(fresh.labelers, []);
  assert.equal(fresh.adjudicated_by, null);
  assert.equal(fresh.confidence, null);
  assert.notEqual(readFileSync(result.predictions_path, 'utf8'), labeled[1]);
  annotate(result.jsonl_path, { gold_state: 'tier-0-win', labelers: ['human-a', 'human-b'], adjudicated_by: 'human-c', confidence: 'high' });
  const imported = importLabels({ worksheetFile: result.jsonl_path, metaDir: join(dir, 'meta') });
  assert.equal(imported.status, 'OK');
  assert.equal(imported.blinded, true, 'replacement worksheet commitments match its replacement predictions');
  assert.equal(imported.labeled_count, 1);
});

test('an unlabeled same-day worksheet may refresh without accumulating duplicate rows', t => {
  const { options, first } = fixture(t);
  const result = exportWorksheet(options);
  assert.equal(result.status, 'OK');
  assert.equal(result.jsonl_path, first.jsonl_path);
  assert.equal(readFileSync(result.jsonl_path, 'utf8').trim().split('\n').length, 1);
});

test('unparseable existing worksheet fails closed without changing any artifact', t => {
  const { options, first } = fixture(t);
  writeFileSync(first.jsonl_path, '{"gold_state":"capture-miss"');
  const before = snapshot(first);
  const result = exportWorksheet(options);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.error_code, 'worksheet-unreadable');
  assert.deepEqual(snapshot(first), before);
});

test('a subsequent date may export while preserving the earlier labeled worksheet', t => {
  const { options, first } = fixture(t);
  annotate(first.jsonl_path, { gold_state: 'capture-miss' });
  const before = snapshot(first);
  const result = exportWorksheet({ ...options, today: '2026-10-03' });
  assert.equal(result.status, 'OK');
  assert.notEqual(result.jsonl_path, first.jsonl_path);
  assert.deepEqual(snapshot(first), before);
});

test('CLI refuses same-day labeled worksheet unless --replace-existing is explicit', t => {
  const root = mkdtempSync(join(tmpdir(), 'calibration-cli-preservation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  mkdirSync(join(home,'.core'));writeFileSync(join(home,'.core','projects.json'),JSON.stringify([{path:project}]));
  const isolate = join(root, 'isolate.mjs');
  // Test-only OS-home shim prevents all CLI state writes from reaching the real account.
  writeFileSync(isolate, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const original=os.userInfo; os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(home)}}); syncBuiltinESMExports();`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '', CORE_HARNESS: 'codex' };
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(isolate).href, ...args], { env, encoding: 'utf8' });
  const resolved = run(['--input-type=module', '-e', `import {operationalMetricsDir} from ${JSON.stringify(METRICS_URL)}; console.log(operationalMetricsDir(${JSON.stringify(project)}));`]);
  assert.equal(resolved.status, 0, resolved.stderr);
  const meta = resolved.stdout.trim();
  assert.ok(meta.startsWith(realpathSync(root)), 'CLI data stays within the disposable fixture');
  const classifiedDir = join(meta, 'classified');
  mkdirSync(classifiedDir);
  writeFileSync(join(classifiedDir, '2026-10-02.jsonl'), JSON.stringify(row('codex')) + '\n');
  const args = [SCRIPT, project, '--harness', 'codex', '--export-worksheet'];
  const initial = run(args);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const jsonlPath = initial.stdout.match(/JSONL: (.+)/)[1].trim();
  const result = { jsonl_path: jsonlPath, predictions_path: jsonlPath.replace(/\.jsonl$/, '.predictions.json'), md_path: jsonlPath.replace(/\.jsonl$/, '.md') };
  annotate(jsonlPath, { gold_state: 'capture-miss', labelers: ['human-a'] });
  const before = snapshot(result);
  const refused = run(args);
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(refused.stdout, /--replace-existing/);
  assert.deepEqual(snapshot(result), before);
  const replaced = run([...args, '--replace-existing']);
  assert.equal(replaced.status, 0, replaced.stderr || replaced.stdout);
  assert.equal(JSON.parse(readFileSync(jsonlPath, 'utf8').trim()).gold_state, null);
});


test('an unreadable existing worksheet fails closed without rotating its predictions', t => {
  const { options, first } = fixture(t);
  const before = snapshot(first);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    const read = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (path === ${JSON.stringify(first.jsonl_path)}) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      return read(path, ...args);
    };
    syncBuiltinESMExports();
    const { exportWorksheet } = await import(${JSON.stringify(CALIBRATION_URL)});
    const result = exportWorksheet(${JSON.stringify(options)});
    assert.equal(result.status, 'ERROR');
    assert.equal(result.error_code, 'worksheet-unreadable');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(first), before);
});


for (const harness of ['claude-code', 'codex']) test(`CLI --harness ${harness} binds export, readiness and label import despite the opposite ambient harness`, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'calibration-explicit-harness-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const home=join(root,'home'), project=join(root,'project');
  mkdirSync(join(home,'.core'),{recursive:true}); mkdirSync(project);
  writeFileSync(join(home,'.core','projects.json'), JSON.stringify([{path:project}]));
  const meta=join(project,'.core',harness,'metrics');
  const opposite=harness==='codex'?'claude-code':'codex';
  const isolate=join(root,'isolate.mjs');
  writeFileSync(isolate, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const original=os.userInfo; os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(home)}}); syncBuiltinESMExports();`);
  const env={...process.env, HOME:home, USERPROFILE:home, NODE_OPTIONS:'', CORE_HARNESS:opposite};
  const run=args=>spawnSync(process.execPath,['--import',pathToFileURL(isolate).href,...args],{env,encoding:'utf8'});
  const initialize=run(['--input-type=module','-e',`import {operationalMetricsDir} from ${JSON.stringify(METRICS_URL)}; console.log(operationalMetricsDir(${JSON.stringify(project)},{harness:${JSON.stringify(harness)}}));`]);
  assert.equal(initialize.status,0,initialize.stderr); assert.equal(initialize.stdout.trim(),meta);
  mkdirSync(join(meta,'classified')); writeFileSync(join(meta,'classified','2026-10-02.jsonl'),JSON.stringify(row(harness))+'\n');
  const exported=run([SCRIPT,project,'--harness',harness,'--export-worksheet']);
  assert.equal(exported.status,0,exported.stderr||exported.stdout);
  const worksheet=exported.stdout.match(/JSONL: (.+)/)[1].trim();
  assert.ok(worksheet.startsWith(join(meta,'calibration')),worksheet);
  const checked=run([SCRIPT,project,'--harness',harness,'--check','--json']);
  const view=JSON.parse(checked.stdout); assert.equal(view.metaDir,meta); assert.equal(view.pool_size,1);
  annotate(worksheet,{gold_state:'tier-0-win',labelers:['human-a','human-b'],adjudicated_by:'human-c',confidence:'high'});
  const before=readFileSync(worksheet);
  const imported=run([SCRIPT,project,'--harness',harness,'--import-labels',worksheet,'--json']);
  assert.equal(imported.status,0,imported.stderr||imported.stdout); assert.equal(JSON.parse(imported.stdout).harness,harness);
  assert.deepEqual(readFileSync(worksheet),before,'import preserves human labels');
  const mismatched=run([SCRIPT,project,'--harness',opposite,'--import-labels',worksheet,'--json']);
  assert.equal(mismatched.status,1); assert.equal(JSON.parse(mismatched.stdout).status,'ERROR');
  assert.match(JSON.parse(mismatched.stdout).message,/harness/i);
});
