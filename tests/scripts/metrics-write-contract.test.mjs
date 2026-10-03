/** Finding 6: opt-out suppresses automatic metrics writes; write failures stay visible. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/scripts');
const scriptUrl = name => pathToFileURL(join(scripts, name)).href;
const now = '2026-10-02T12:00:00Z';
const day = '2026-10-02';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(join(project, '_memories'), { recursive: true });
  writeFileSync(join(project, '_memories', 'unit-1.md'), '---\nid: unit-1\ntype: decision\n---\n# Synthetic decision\n');
  // HOME alone does not isolate CORE's trusted OS-account home. Keep the shim
  // inside the disposable child and import product code only after it runs.
  const isolate = join(root, 'isolate.mjs');
  writeFileSync(isolate, `import os from 'node:os';\nimport {syncBuiltinESMExports} from 'node:module';\nconst original=os.userInfo;\nos.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(home)}});\nsyncBuiltinESMExports();\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '',
    CORE_HARNESS: 'claude-code', CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '1',
    CORE_METRICS_FORCE_PROJECT_LOCAL: '', CORE_METRICS_FORCE_APPDATA_FALLBACK: '' };
  const run = (args, extra = {}) => spawnSync(process.execPath,
    ['--import', pathToFileURL(isolate).href, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const evaluate = (body, extra) => {
    const child = run(['--input-type=module', '-e', `
      import fs from 'node:fs'; import {join} from 'node:path';
      const project=${JSON.stringify(project)}, home=${JSON.stringify(home)};
      ${body}`], extra);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  return { project, home, run, evaluate };
}

function plantInputs(project) {
  mkdirSync(join(project, '_sessions', day), { recursive: true });
  writeFileSync(join(project, '_sessions', day, 'self-test-log.jsonl'),
    JSON.stringify({ kind: 'self-test-run', ts: `${day}T00:00:00Z`, round: 1, headline: 1 }) + '\n');
  mkdirSync(join(project, '_metrics', 'turn-capture'), { recursive: true });
  writeFileSync(join(project, '_metrics', 'turn-capture', `${day}.jsonl`),
    JSON.stringify({ kind: 'turn-evidence', retrieval_id: 'synthetic-old-turn', prompt_text: 'synthetic decision', store_signature: 'stale' }) + '\n');
}

const optOuts = [
  ['environment', { CORE_METRICS_ENABLED: '0' }],
  ['workspace', { CORE_METRICS_ENABLED: '' }],
];
function optOut(f, label) {
  if (label === 'workspace') writeFileSync(join(f.project, 'workspace.json'), JSON.stringify({ metrics_enabled: false }));
}

for (const [label, flags] of optOuts) {
  for (const existing of [false, true]) {
    test(`maintenance ${label} opt-out ${existing ? 'preserves existing metrics' : 'creates no metrics'} while memory maintenance runs`, t => {
      const f = fixture(t);
      plantInputs(f.project);
      optOut(f, label);
      const scorecard = join(f.project, '_metrics', 'scorecard-log.jsonl');
      const trigger = join(f.project, '_tests', 'self-test', 'auto-author-state.json');
      if (existing) {
        writeFileSync(scorecard, '{"kind":"scorecard","ts":"2020-01-01T00:00:00Z"}\n');
        mkdirSync(dirname(trigger), { recursive: true });
        writeFileSync(trigger, '{"last_trigger_ts":"2020-01-01T00:00:00Z"}\n');
      }
      const before = [scorecard, trigger].map(p => existsSync(p) ? readFileSync(p, 'utf8') : null);
      const result = f.evaluate(`
        const {runMaintenance}=await import(${JSON.stringify(scriptUrl('maintenance-run.mjs'))});
        console.log(JSON.stringify(runMaintenance(project,{home,now:${JSON.stringify(now)}})));
      `, flags);
      assert.deepEqual([scorecard, trigger].map(p => existsSync(p) ? readFileSync(p, 'utf8') : null), before,
        'opt-out must neither create nor update scorecard/auto-author output');
      assert.equal(existsSync(join(f.project, '_metrics', 'judgment-log.jsonl')), false);
      assert.equal(result.ranOps.includes('scorecard-computation'), false);
      assert.equal(result.ranOps.includes('hindsight-judge'), false);
      assert.equal(result.notes.some(n => /self-test round authoring is due/.test(n)), false);
      assert.ok(existsSync(join(f.project, '_memories', 'INDEX-decisions.md')));
      assert.ok(existsSync(join(f.project, '_memories', '_maintenance-state.json')));
    });
  }

  test(`appendScorecard refuses ${label} opt-out at the writer boundary`, t => {
    const f = fixture(t);
    optOut(f, label);
    const result = f.evaluate(`
      const {appendScorecard}=await import(${JSON.stringify(scriptUrl('scorecard.mjs'))});
      console.log(JSON.stringify(appendScorecard(project,{kind:'scorecard',ts:${JSON.stringify(now)}})));
    `, flags);
    assert.deepEqual(result, { written: false, reason: 'metrics-disabled' });
    assert.equal(existsSync(join(f.project, '_metrics')), false, 'no directory or lock created');
  });
}

test('enabled maintenance still judges evidence, pins a scorecard and stamps the author trigger', t => {
  const f = fixture(t);
  plantInputs(f.project);
  const result = f.evaluate(`
    const {runMaintenance}=await import(${JSON.stringify(scriptUrl('maintenance-run.mjs'))});
    console.log(JSON.stringify(runMaintenance(project,{home,now:${JSON.stringify(now)}})));
  `);
  assert.ok(result.ranOps.includes('hindsight-judge'));
  assert.ok(result.ranOps.includes('scorecard-computation'));
  assert.ok(existsSync(join(f.project, '_metrics', 'judgment-log.jsonl')));
  assert.ok(existsSync(join(f.project, '_metrics', 'scorecard-log.jsonl')));
  assert.ok(existsSync(join(f.project, '_tests', 'self-test', 'auto-author-state.json')));
});

for (const [label, flags] of [...optOuts, ['enabled', {}]]) {
  test(`maintenance CLI ${label}: automatic regrade follows the metrics gate`, t => {
    const f = fixture(t);
    cpSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/obligation3-store'), f.project, { recursive: true });
    const setup = f.evaluate(`
      const {newRound,register}=await import(${JSON.stringify(scriptUrl('self-test-round.mjs'))});
      const {loadSnapshot}=await import(${JSON.stringify(scriptUrl('generate-summary-index.mjs'))});
      newRound(project);
      const gold={meta:{round:1,authoring_snapshot_id:loadSnapshot(project,{captureBodies:true}).snapshotId,author:'test',blind_attestation:'synthetic'},
        queries:[{id:'q1',query:'omega speedmaster sale',rung:'literal',expected:['want-omega-speedmaster-on-sale-wait']}]};
      const goldPath=join(project,'gold.json'); fs.writeFileSync(goldPath,JSON.stringify(gold));
      console.log(JSON.stringify(register(project,1,goldPath)));
    `);
    assert.equal(setup.ok, true, JSON.stringify(setup));
    optOut(f, label);
    const child = f.run([join(scripts, 'maintenance-run.mjs'), f.project, '--json'], flags);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    const sessions = join(f.project, '_sessions');
    const logs = existsSync(sessions) ? fsSessionLogs(sessions) : [];
    if (label === 'enabled') {
      assert.ok(result.self_test_regrade);
      assert.equal(logs.length, 1, 'enabled positive control reaches the log append');
      assert.match(logs[0], /auto-regrade/);
    } else {
      assert.equal(result.self_test_regrade, null);
      assert.deepEqual(logs, [], 'disabled automatic regrade adds no self-test log');
    }
  });
}

// Session dates are product-selected; read all generated dates, not the test date.
function fsSessionLogs(sessions) {
  return readdirSync(sessions).map(d => join(sessions, d, 'self-test-log.jsonl'))
    .filter(existsSync).map(p => readFileSync(p, 'utf8'));
}

function classificationSetup(turns = 1) {
  return `
    const {mapProjectPathToSlug}=await import(${JSON.stringify(scriptUrl('project-slug.mjs'))});
    const {operationalMetricsDir}=await import(${JSON.stringify(scriptUrl('log-event.mjs'))});
    const transcriptDir=join(home,'.claude','projects',mapProjectPathToSlug(project));
    fs.mkdirSync(transcriptDir,{recursive:true});
    const events=Array.from({length:${turns}},(_,i)=>[
      {message:{role:'user',content:[{type:'text',text:'synthetic question '+i}]}},
      {message:{role:'assistant',content:[{type:'text',text:'synthetic answer '+i}]}}
    ]).flat();
    fs.writeFileSync(join(transcriptDir,'synthetic-session.jsonl'),events.map(e=>JSON.stringify(e)).join('\\n')+'\\n');
    const classifiedDir=join(operationalMetricsDir(project,{home}),'classified');
    fs.mkdirSync(classifiedDir,{recursive:true});
    const classifiedFile=join(classifiedDir,${JSON.stringify(day + '.jsonl')});
  `;
}
const runClassification = `
  const {runClassification}=await import(${JSON.stringify(scriptUrl('classify-turns.mjs'))});
  const result=runClassification({project,home,sessionId:'synthetic-session',today:${JSON.stringify(day)}});
`;

test('classified append failure is non-OK and reports zero confirmed written records', t => {
  const f = fixture(t);
  const result = f.evaluate(classificationSetup() + `
    fs.mkdirSync(classifiedFile);
    ${runClassification}
    console.log(JSON.stringify(result));
  `);
  assert.equal(result.status, 'WRITE_FAILED');
  assert.equal(result.written, false);
  assert.equal(result.written_records, 0);
  assert.match(result.error_code, /^(EISDIR|EACCES|EPERM)$/);
  assert.equal(result.total, 1, 'classification result is retained separately from persistence');
});

test('a later classified append failure reports only the successfully written prefix', t => {
  const f = fixture(t);
  const result = f.evaluate(classificationSetup(2) + `
    const {syncBuiltinESMExports}=await import('node:module');
    const append=fs.appendFileSync; let calls=0;
    fs.appendFileSync=(file,...args)=>{
      if(file===classifiedFile && ++calls===2) throw Object.assign(new Error('synthetic append failure'),{code:'EIO'});
      return append(file,...args);
    };
    syncBuiltinESMExports();
    ${runClassification}
    console.log(JSON.stringify({result,rows:fs.readFileSync(classifiedFile,'utf8').trim().split('\\n').map(JSON.parse)}));
  `);
  assert.equal(result.result.status, 'WRITE_FAILED');
  assert.equal(result.result.written, false);
  assert.equal(result.result.written_records, 1);
  assert.equal(result.result.error_code, 'EIO');
  assert.equal(result.result.total, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].turn_idx, 0);
});

test('successful and empty classifications report their actual written counts', t => {
  for (const turns of [0, 2]) {
    const f = fixture(t);
    const output = f.evaluate(classificationSetup(turns) + runClassification + `
      console.log(JSON.stringify({result,rows:fs.existsSync(classifiedFile)?fs.readFileSync(classifiedFile,'utf8').trim().split('\\n').map(JSON.parse):[]}));
    `);
    assert.equal(output.result.status, 'OK');
    assert.equal(output.result.written, true);
    assert.equal(output.result.written_records, turns);
    assert.equal(output.result.total, turns);
    assert.equal(output.rows.length, turns);
  }
});

test('classification CLI signals an append failure with a nonzero exit and JSON diagnostic', t => {
  const f = fixture(t);
  f.evaluate(classificationSetup() + `
    fs.mkdirSync(join(classifiedDir,new Date().toISOString().slice(0,10)+'.jsonl'));
    console.log('{}');
  `);
  const child = f.run([join(scripts, 'classify-turns.mjs'), f.project, '--json'], { CLAUDE_CODE_SESSION_ID: 'synthetic-session' });
  assert.equal(child.status, 1, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'WRITE_FAILED');
  assert.equal(result.written_records, 0);
});
