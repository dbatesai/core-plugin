import { registerFixtureProject } from './registered-project-fixture.mjs';
/** Production-path privacy boundaries. Synthetic data and isolated OS home only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/scripts');
const sentinel = 'SYNTHETIC_PRIVATE_CLOSE_PROMPT';
const pathSentinel = 'SYNTHETIC_PRIVATE_CLOSE_PATH';
const session = 'synthetic-close-session';
const scriptUrl = name => pathToFileURL(join(scripts, name)).href;

function fixture(t, suffix = 'project') {
  const root = mkdtempSync(join(tmpdir(), 'core-close-privacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, suffix);
  mkdirSync(home, { recursive: true });
  registerFixtureProject(home, project);
  mkdirSync(join(project, '_memories'), { recursive: true });
  // CORE's trusted-home ignores HOME. Patch the OS-account accessor only in this
  // disposable child's preload, BEFORE imports, and synchronize named exports.
  const isolate = join(root, 'isolate.mjs');
  writeFileSync(isolate, `import os from 'node:os';\nimport {syncBuiltinESMExports} from 'node:module';\nconst original=os.userInfo;\nos.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(home)}});\nsyncBuiltinESMExports();\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '',
    CORE_HARNESS: 'claude-code', CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '1' };
  const transcript = join(root, `${session}.jsonl`);
  writeFileSync(transcript, [
    { timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: sentinel }] } },
    { timestamp: '2026-10-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: pathSentinel } }] } },
    { timestamp: '2026-10-01T00:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: sentinel }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const run = (args, extra = {}) => spawnSync(process.execPath, ['--import', pathToFileURL(isolate).href, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const evaluate = (body, extra) => {
    const child = run(['--input-type=module', '-e', body], extra);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  const close = (extra = {}, id = session) => {
    const child = run([join(scripts, 'close-pass.mjs'), 'process-request', project, '--session', id, '--transcript', transcript, '--json'], extra);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  const purge = (apply = false) => {
    const child = run([join(scripts, 'turn-capture.mjs'), project, '--purge', ...(apply ? ['--apply'] : [])]);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  return { root, home, project, run, evaluate, close, purge };
}

function treeText(dir) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { withFileTypes: true }).map(e => e.isDirectory()
    ? treeText(join(dir, e.name)) : e.isFile() ? readFileSync(join(dir, e.name), 'utf8') : '').join('\n');
}

for (const [label, flags, workspace] of [
  ['metrics-off', { CORE_METRICS_ENABLED: '0', CORE_TURN_CAPTURE: '1' }],
  ['capture-off', { CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '0' }],
  ['both-off', { CORE_METRICS_ENABLED: '0', CORE_TURN_CAPTURE: '0' }],
  ['workspace-metrics-off', { CORE_METRICS_ENABLED: '', CORE_TURN_CAPTURE: '' }, { metrics_enabled: false }],
  ['workspace-capture-off', { CORE_METRICS_ENABLED: '', CORE_TURN_CAPTURE: '' }, { turn_capture: false }],
]) {
  test(`capture gate: ${label} keeps lifecycle but no transcript payload`, t => {
    const f = fixture(t);
    if (workspace) writeFileSync(join(f.project, 'workspace.json'), JSON.stringify(workspace));
    const { receipt } = f.close(flags);
    assert.equal(receipt.session_id, session);
    assert.equal(receipt.status, 'recorded');
    assert.deepEqual(receipt.record.counts, { events: 3, tools: 1, mutating_tools: 1, user_turns: 1 });
    assert.equal(receipt.record.opening_request, '');
    assert.deepEqual(receipt.record.files_touched, []);
    for (const text of [JSON.stringify(receipt), treeText(join(f.project, '_metrics')), treeText(f.home)]) {
      assert.ok(!text.includes(sentinel), 'disabled capture must retain no prompt bytes');
      assert.ok(!text.includes(pathSentinel), 'disabled capture must retain no tool-input path bytes');
    }
    assert.equal(f.close(flags).skipped, true, 'lifecycle dedup still works');
  });
}

test('capture enabled control retains the bounded opening and file list', t => {
  const f = fixture(t);
  const { receipt } = f.close();
  assert.equal(receipt.record.opening_request, sentinel);
  assert.deepEqual(receipt.record.files_touched, [pathSentinel]);
  assert.ok(readFileSync(receipt.summary_path, 'utf8').includes(sentinel));
});

for (const tamper of [false, true]) {
  test(`storage: a synced project with a ${tamper ? 'tampered' : 'missing'} pin keeps close artifacts in its own _metrics`, t => {
    const f = fixture(t, 'OneDrive/project');
    f.evaluate(`
      import { initMetrics } from ${JSON.stringify(scriptUrl('metrics-init.mjs'))};
      import { operationalMetricsDir } from ${JSON.stringify(scriptUrl('log-event.mjs'))};
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const project=${JSON.stringify(f.project)};
      if (${tamper}) { initMetrics({projectDir:project}); writeFileSync(join(operationalMetricsDir(project), 'storage-path.txt'), '/SYNTHETIC_INVALID_PIN'); }
      console.log('{}');
    `);
    const store = join(f.project, '_metrics');
    const { receipt } = f.close({ CORE_METRICS_ENABLED: '0', CORE_TURN_CAPTURE: '0' });
    assert.equal(dirname(dirname(dirname(receipt.summary_path))), store, 'close writes to the project store, pin or no pin');
    assert.ok(existsSync(join(store, 'close', 'receipts')));
    assert.ok(!treeText(store).includes(sentinel));
    assert.equal(f.close().skipped, true, 'receipt reads use the same route as writes');
  });
}

test('Git boundary: ordinary git add -A stages no generated close payload', t => {
  const f = fixture(t);
  const git = args => {
    const result = spawnSync('git', ['-C', f.project, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['init', '--quiet']);
  writeFileSync(join(f.project, 'README.md'), 'synthetic project');
  const { receipt } = f.close();
  assert.ok(readFileSync(receipt.summary_path, 'utf8').includes(sentinel));
  git(['add', '-A']);
  const tracked = git(['ls-files']);
  assert.ok(tracked.includes('README.md'), 'positive staging control');
  assert.ok(!tracked.includes('_metrics/close/'), tracked);
  const ignored = spawnSync('git', ['-C', f.project, 'check-ignore', relative(f.project, receipt.summary_path)], { encoding: 'utf8' });
  assert.equal(ignored.status, 0, 'generated summary is actively ignored');
});

test('purge boundary: explicit only, generated marker required, manual and historical material survive', t => {
  const f = fixture(t);
  const { receipt } = f.close();
  const summaries = dirname(receipt.summary_path);
  const receipts = join(dirname(summaries), 'receipts');
  const receiptPath = join(receipts, readdirSync(receipts).find(n => n.endsWith('.json')));
  const manualSummary = join(summaries, 'a'.repeat(64) + '.md');
  const historicalReceipt = join(receipts, 'b'.repeat(64) + '.json');
  const manualMemory = join(f.project, '_summaries', 'human.md');
  mkdirSync(dirname(manualMemory), { recursive: true });
  writeFileSync(manualSummary, '# Hand-written summary\n' + sentinel);
  writeFileSync(historicalReceipt, JSON.stringify({ ...receipt, generated_close: undefined }));
  writeFileSync(manualMemory, '# Human-authored session meaning\n' + sentinel);
  // A manual certification receipt is also unmarked, even though code writes it.
  f.evaluate(`import { writeCloseReceipt } from ${JSON.stringify(scriptUrl('close-pass.mjs'))};
    console.log(JSON.stringify(writeCloseReceipt(${JSON.stringify(f.project)}, { session_id:'manual-session', status:'closed', summary_path:${JSON.stringify(manualMemory)} })));`);
  const manualReceipt = readdirSync(receipts).filter(n => n.endsWith('.json')).map(n => join(receipts, n))
    .find(p => JSON.parse(readFileSync(p, 'utf8')).session_id === 'manual-session');
  const keep = [manualSummary, historicalReceipt, manualMemory, manualReceipt];
  const before = keep.map(p => readFileSync(p, 'utf8'));
  const dry = f.purge();
  assert.equal(dry.reason, 'dry-run');
  assert.ok(existsSync(receipt.summary_path));
  assert.ok(existsSync(receiptPath));
  f.close({}, 'another-synthetic-session');
  assert.ok(existsSync(receipt.summary_path), 'ordinary close must not delete existing files');
  const purged = f.purge(true);
  assert.equal(purged.purged, true, JSON.stringify(purged));
  assert.equal(existsSync(receipt.summary_path), false, 'generated summary purged');
  assert.equal(existsSync(receiptPath), false, 'generated receipt purged');
  assert.ok(purged.scope.some(e => e.id === 'close-summaries'));
  assert.ok(purged.scope.some(e => e.id === 'close-receipts'));
  for (let i = 0; i < keep.length; i++) assert.equal(readFileSync(keep[i], 'utf8'), before[i], `preserve ${keep[i]}`);
  assert.equal(f.purge(true).purged, true, 'repeat explicit purge is idempotent');
});

for (const edited of ['summary', 'receipt']) {
  test(`purge boundary: user-edited generated ${edited} is preserved independently`, t => {
    const f = fixture(t);
    const { receipt } = f.close();
    const dir = join(dirname(dirname(receipt.summary_path)), 'receipts');
    const file = join(dir, readdirSync(dir).find(n => n.endsWith('.json')));
    let editedPath, editedText;
    if (edited === 'summary') {
      editedPath = receipt.summary_path;
      editedText = readFileSync(editedPath, 'utf8') + '\nA human added this note.\n';
    } else {
      editedPath = file;
      const body = JSON.parse(readFileSync(file, 'utf8'));
      body.human_note = 'Keep this addition';
      editedText = JSON.stringify(body);
    }
    writeFileSync(editedPath, editedText);
    assert.equal(f.purge(true).purged, true);
    assert.equal(readFileSync(editedPath, 'utf8'), editedText);
  });
}

test('capture gates share the trusted OS home even when HOME differs', t => {
  const f = fixture(t);
  f.evaluate(`
    import { operationalMetricsDir, captureDisabledMarkerPath } from ${JSON.stringify(scriptUrl('log-event.mjs'))};
    import { mkdirSync, writeFileSync } from 'node:fs'; import {join} from 'node:path';
    const project=${JSON.stringify(f.project)};
    const meta=operationalMetricsDir(project); mkdirSync(meta,{recursive:true});
    writeFileSync(join(meta,'capture-disabled.json'),'{"marker":"core-capture-disabled"}');
    if (!captureDisabledMarkerPath(project)) throw new Error('fixture marker must switch capture off');
    console.log('{}');
  `);
  const spoofedHome = join(f.root, 'other-home');
  mkdirSync(spoofedHome);
  const { receipt } = f.close({ HOME: spoofedHome, USERPROFILE: spoofedHome });
  assert.equal(receipt.record.opening_request, '', 'the real OS-home marker must disable close content');
  assert.deepEqual(receipt.record.files_touched, []);
});

test('purge boundaries: orphan marked summary, same-session manual receipt, malformed and nested files', t => {
  const f = fixture(t);
  const { receipt } = f.close();
  const closeDir = dirname(dirname(receipt.summary_path));
  const receipts = join(closeDir, 'receipts');
  const automaticReceipt = join(receipts, readdirSync(receipts).find(n => n.endsWith('.json')));
  rmSync(automaticReceipt); // simulate interrupted writer after summary
  const manual = f.close({}, 'manual-replaces-auto').receipt;
  f.evaluate(`import { writeCloseReceipt } from ${JSON.stringify(scriptUrl('close-pass.mjs'))};
    console.log(JSON.stringify(writeCloseReceipt(${JSON.stringify(f.project)}, { session_id:'manual-replaces-auto', status:'closed', summary_path:${JSON.stringify(manual.summary_path)} })));`);
  const nested = join(closeDir, 'summaries', 'nested', 'a'.repeat(64) + '.md');
  mkdirSync(dirname(nested));
  writeFileSync(nested, readFileSync(receipt.summary_path, 'utf8'));
  const quarantine = automaticReceipt + '.corrupt-123';
  writeFileSync(quarantine, JSON.stringify(receipt));
  const wrongName = join(receipts, 'c'.repeat(64) + '.json');
  writeFileSync(wrongName, JSON.stringify(receipt));
  const changedMarker = join(closeDir, 'summaries', 'd'.repeat(64) + '.md');
  writeFileSync(changedMarker, readFileSync(receipt.summary_path, 'utf8').replace('core.generated-close/1', 'core.generated-close/0'));
  const keep = [manual.summary_path, nested, quarantine, wrongName, changedMarker];
  const before = keep.map(p => readFileSync(p, 'utf8'));
  const purged = f.purge(true);
  assert.equal(purged.purged, true);
  assert.equal(existsSync(receipt.summary_path), false, 'orphan writer-marked summary still purgeable');
  for (let i=0;i<keep.length;i++) assert.equal(readFileSync(keep[i],'utf8'),before[i]);
});

test('writer and purge refuse a linked generated directory', t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  const close = join(f.project, '_metrics', 'close');
  mkdirSync(dirname(close), { recursive: true });
  // A junction needs no privilege on Windows and is the realistic plant there.
  symlinkSync(outside, close, process.platform === 'win32' ? 'junction' : 'dir');
  const denied = f.run([join(scripts, 'close-pass.mjs'), 'process-request', f.project, '--session', session]);
  assert.notEqual(denied.status, 0);
  assert.deepEqual(readdirSync(outside), [], 'no payload outside selected close root');
  const purge = f.run([join(scripts, 'turn-capture.mjs'), f.project, '--purge', '--apply']);
  assert.equal(purge.status, 2, purge.stderr);
  assert.equal(JSON.parse(purge.stdout).purged, false);
});

test('purge preserves a linked file in a generated directory', { skip: process.platform === 'win32' ? 'file symlink creation may require elevated Windows privileges' : false }, t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  const { receipt } = f.close();
  const preserved = join(outside, 'human.md');
  writeFileSync(preserved, readFileSync(receipt.summary_path, 'utf8'));
  const linked = join(dirname(receipt.summary_path), 'e'.repeat(64) + '.md');
  symlinkSync(preserved, linked);
  assert.equal(f.purge(true).purged, true);
  assert.ok(existsSync(linked));
  assert.ok(readFileSync(preserved, 'utf8').includes(sentinel));
});

test('shared lock blocks close and explicit purge; manual terminal receipt wins recheck', t => {
  const f = fixture(t);
  const observed = f.evaluate(`
    import { runDeterministicClose, writeCloseReceipt } from ${JSON.stringify(scriptUrl('close-pass.mjs'))};
    import { purgeTurnCapture } from ${JSON.stringify(scriptUrl('turn-capture.mjs'))};
    import { withFileLock } from ${JSON.stringify(scriptUrl('file-lock.mjs'))};
    import { join } from 'node:path'; import { mkdirSync } from 'node:fs';
    const project=${JSON.stringify(f.project)}; mkdirSync(join(project,'_metrics'),{recursive:true});
    let closeBlocked=false, purgeBlocked=false;
    withFileLock(join(project,'_metrics','.turn-capture.lock'),()=>{
      try { runDeterministicClose(project,{sessionId:'locked',events:[]}); } catch(e) {closeBlocked=e.code==='LOCK_HELD';}
      purgeBlocked=!purgeTurnCapture(project,{apply:true}).purged;
    });
    writeCloseReceipt(project,{session_id:'manual-wins',status:'closed',harness:'claude-code',closed_at:'2026-10-03T00:00:00Z',summary_path:null});
    const prior=runDeterministicClose(project,{sessionId:'manual-wins',events:[{kind:'text',role:'user',text:${JSON.stringify(sentinel)}}]});
    console.log(JSON.stringify({closeBlocked,purgeBlocked,prior}));
  `);
  assert.equal(observed.closeBlocked, true);
  assert.equal(observed.purgeBlocked, true);
  assert.equal(observed.prior.status, 'closed');
  assert.equal(observed.prior.record, undefined);
  assert.ok(!treeText(join(f.project, '_metrics')).includes(sentinel));
});

test('purge uses the same trusted home as redirected close when HOME differs', t => {
  const f = fixture(t, 'OneDrive/project');
  f.evaluate(`import {initMetrics} from ${JSON.stringify(scriptUrl('metrics-init.mjs'))};
    const result=initMetrics({projectDir:${JSON.stringify(f.project)}});
    if (!result.ok) throw new Error(JSON.stringify(result)); console.log('{}');`);
  const { receipt } = f.close();
  assert.ok(readFileSync(receipt.summary_path, 'utf8').includes(sentinel));
  const fake = join(f.root, 'fake-home');
  mkdirSync(fake);
  const child = f.run([join(scripts, 'turn-capture.mjs'), f.project, '--purge', '--apply'], { HOME: fake, USERPROFILE: fake });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(JSON.parse(child.stdout).purged, true);
  assert.equal(existsSync(receipt.summary_path), false);
});

test('writer does not overwrite a manual or edited summary at the generated filename', t => {
  const f = fixture(t);
  const { receipt } = f.close();
  const receipts = join(dirname(dirname(receipt.summary_path)), 'receipts');
  rmSync(join(receipts, readdirSync(receipts).find(n => n.endsWith('.json'))));
  const humanText = '# Human-owned summary\nKeep exactly this';
  writeFileSync(receipt.summary_path, humanText);
  const retry = f.run([join(scripts, 'close-pass.mjs'), 'process-request', f.project, '--session', session, '--transcript', join(f.root, `${session}.jsonl`)]);
  assert.notEqual(retry.status, 0);
  assert.equal(readFileSync(receipt.summary_path, 'utf8'), humanText);
});

test('first-use initialization is serialized and tolerates an identical self-ignore winner', t => {
  const f = fixture(t);
  const observed = f.evaluate(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.writeFileSync; let races=0;
    fs.writeFileSync=(file,...args)=>{
      if (String(file).endsWith('.gitignore') && args[1]?.flag==='wx') {
        original(file,...args); races++; throw Object.assign(new Error('synthetic competing creator'),{code:'EEXIST'});
      }
      return original(file,...args);
    };
    syncBuiltinESMExports();
    const {runDeterministicClose}=await import(${JSON.stringify(scriptUrl('close-pass.mjs'))});
    const receipt=runDeterministicClose(${JSON.stringify(f.project)},{sessionId:'first-use'});
    console.log(JSON.stringify({status:receipt.status,races}));
  `);
  assert.equal(observed.status, 'recorded');
  assert.equal(observed.races, 3, 'close root, summary dir and receipt dir each establish exclusion');
});
