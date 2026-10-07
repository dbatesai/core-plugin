#!/usr/bin/env node
/**
 * Finds out WHY a concurrent stamp is lost: runs N processes that each stamp a distinct file into one fresh project
 * and, for every stamp that did not land, prints what its process returned (stamped:false plus the reason).
 *
 *   node scripts/release/lost-stamp-probe.mjs [rounds=100] [processes=40]
 *
 * Every child runs under the same disposable account home as the isolated suite runner, so nothing is written
 * to the real home. Exit 1 if any stamp was lost.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = pathToFileURL(join(ROOT, 'plugins', 'core', 'skills', 'core', 'scripts', 'state-cache.mjs')).href;
const PRELOAD_URL = pathToFileURL(join(ROOT, 'tests', 'helpers', 'account-home-preload.mjs')).href;
const { projectCachePath } = await import(SCRIPT);
const rounds = Number(process.argv[2]) || 100, N = Number(process.argv[3]) || 40;
const reasons = new Map();
let lostRounds = 0;
for (let round = 1; round <= rounds; round++) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lost-stamp-probe-')));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project, { recursive: true }); mkdirSync(join(home, '.core'), { recursive: true });
  const code = (i) => `import { stampFile } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(stampFile(${JSON.stringify(project)}, '/c-${i}.md', 'abcdef0123456789', 'probe', { now: '2026-07-22T00:00:00Z', home: ${JSON.stringify(home)} })));`;
  const env = { ...process.env, CORE_TEST_ACCOUNT_HOME: home, NODE_OPTIONS: `--import ${PRELOAD_URL}` };
  const outs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    let o = ''; const p = spawn(process.execPath, ['--input-type=module', '-e', code(i)], { env });
    p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', (c) => res({ i, c, o: o.trim() }));
  })));
  let have = {};
  try { have = JSON.parse(readFileSync(projectCachePath(project), 'utf8')).files || {}; } catch { /* no cache */ }
  const missing = outs.filter((x) => !have[`/c-${x.i}.md`]);
  if (missing.length) {
    lostRounds++;
    for (const x of missing) {
      let key; try { const r = JSON.parse(x.o.split('\n').pop()); key = `${r.outcome || ''} | ${r.reason || ''} | ${r.primaryError?.code || ''} ${r.primaryError?.message || ''}`.replace(/\S*lost-stamp-probe-\w+/g, '<tmp>').slice(0, 400); } catch { key = `exit ${x.c}: ${x.o.replace(/\S*lost-stamp-probe-\w+/g, '<tmp>').slice(0, 400)}`; }
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
  }
  rmSync(root, { recursive: true, force: true });
}
console.log(`${lostRounds}/${rounds} rounds lost at least one stamp (${N} processes each)`);
for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`${n} x ${k}`);
process.exitCode = lostRounds ? 1 : 0;
