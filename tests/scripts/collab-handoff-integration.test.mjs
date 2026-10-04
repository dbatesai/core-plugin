// Row-11 integration: a registered project, a real collab round, the real hook decision path,
// the real sync and landing, and the real per-turn retrieval hook process showing the notice.
// The one injected piece is collab discovery — deliberately not redirectable by environment —
// pointed at collab's scripts ($COLLAB_SCRIPTS_DIR or the sibling checkout). Skips by name without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trustedTestTmpRoot, registryEnvFor } from './trusted-test-tmp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(__dirname, '../../plugins/core/skills/core');
const COLLAB = process.env.COLLAB_SCRIPTS_DIR || resolve(__dirname, '../../../collab-plugin/skills/collab/scripts');
const skip = existsSync(join(COLLAB, 'collab-outcome.mjs')) ? false : `collab-outcome.mjs not found at ${COLLAB}`;

const ROOT = mkdtempSync(join(tmpdir(), 'collab-int-'));
process.env.COLLAB_LOCAL_ROOT = join(ROOT, 'local');
process.env.COLLAB_STATE_ROOT = join(ROOT, 'state');
process.env.CORE_HARNESS = 'claude-code';
const R1 = 'core-codex@codex:host';

const PROJECT = mkdtempSync(join(trustedTestTmpRoot(), 'collab-int-proj-'));
mkdirSync(join(PROJECT, '_memories'), { recursive: true });
mkdirSync(join(PROJECT, '_sources'), { recursive: true });
writeFileSync(join(PROJECT, '_sources', 'collab.yaml'), 'name: collab\n');
writeFileSync(join(PROJECT, '_memories', 'dc-1-a-decision.md'), '---\nid: dc-1-a-decision\ntype: decision\nstatus: active\n---\nA decision about widgets.\n');
const REG = registryEnvFor(PROJECT);
Object.assign(process.env, REG);

const { runCollabSyncHook, THROTTLE_MS } = await import(pathToFileURL(join(CORE, 'hooks', 'collab-sync-hook.mjs')).href);
const { syncCollab } = await import(pathToFileURL(join(CORE, 'scripts', 'core-collab-sync.mjs')).href);
const inbox = () => (existsSync(join(PROJECT, 'inbox.md')) ? readFileSync(join(PROJECT, 'inbox.md'), 'utf8') : '');
const retrievalHook = (prompt) => spawnSync(process.execPath, [join(CORE, 'hooks', 'retrieve-context-hook.mjs')], {
  input: JSON.stringify({ prompt, cwd: PROJECT }),
  env: { ...process.env, CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: join(ROOT, 'hooks.jsonl'), ...REG },
  encoding: 'utf8',
});

let collab = null;
async function round(tag) {
  collab ??= {
    ...(await import(pathToFileURL(join(COLLAB, 'collab-kickoff.mjs')).href)),
    ...(await import(pathToFileURL(join(COLLAB, 'collab-event-helpers.mjs')).href)),
    ...(await import(pathToFileURL(join(COLLAB, 'collab-tick.mjs')).href)),
  };
  const k = await collab.kickoff(`integration ${tag}`, { workspaceId: 'int-test', transport: 'localhost', capabilitiesWanted: ['review'], measures: [{ id: 'M-1', description: 'lands once', requires_review_from: R1 }] });
  const at = (m) => new Date(Date.now() - (30 - m) * 60000).toISOString();
  const add = (author, type, m, payload, refs = []) => { const e = { event_id: `evt-${tag}-${type}`, ts: at(m), author, slug: k.slug, type, references: refs, payload }; collab.appendEvent(k.dir, e); return e; };
  add(R1, 'join', 1, { capability_match: [], commitment: 'review', owes_review: ['M-1'] }, [k.kickoffEvt.event_id]);
  const pc = add(k.triplet, 'propose-close', 2, { synthesis: 's', igm_met: {} });
  return { k, close: async () => { add(R1, 'ratify', 3, { measures: ['M-1'] }, [pc.event_id]); assert.equal((await collab.tickDeterministic(k.slug, { workspaceId: 'int-test', triplet: k.triplet, dryRun: false })).action, 'close'); } };
}

// The participant comes through the real chain: the project's opaque id → collab's persisted
// identity record → the read-only --show lookup. (The manifest read that yields the id is
// index-registry's own tested surface; the id is passed directly here.)
mkdirSync(join(ROOT, 'identity'), { recursive: true });
writeFileSync(join(ROOT, 'identity', 'proj-int.json'), JSON.stringify({ workspace_id: 'proj-int', triplet: R1, participant_id: 'p-int' }));
const sync = (root, o) => syncCollab(root, { ...o, projectId: 'proj-int' });
const hook = (now) => runCollabSyncHook({ cwd: PROJECT }, { now, findCollab: () => COLLAB, sync });

test('a close after bootstrap lands on a later prompt with no new event, manual sync or /core — exactly once', { skip }, async () => {
  const x = await round('after');
  const t0 = 2_000_000_000_000;
  let r = hook(t0);                                         // a prompt while the collab is still open
  assert.equal(r.action, 'ran');
  assert.deepEqual(r.states, ['open']);
  assert.equal(inbox(), '');
  await x.close();                                          // closes after that prompt
  assert.equal(hook(t0 + 1000).reason, 'throttled');        // inside the window: nothing yet
  r = hook(t0 + THROTTLE_MS);                               // the next prompt past the window
  assert.deepEqual(r.states, ['landed']);
  assert.equal((inbox().match(/^handoff-collab-id: /gm) || []).length, 1);
  r = hook(t0 + 2 * THROTTLE_MS);
  assert.deepEqual(r.states, ['already-landed']);
  assert.equal((inbox().match(/^handoff-collab-id: /gm) || []).length, 1);
});

test('a pending state from the background run is shown once by the real retrieval hook on the next turn', { skip }, async () => {
  const x = await round('pending');
  await x.close();
  const lockPath = join(PROJECT, '_memories', '_lib', 'intake.lock');
  const { acquireFileLock, releaseFileLock } = await import(pathToFileURL(join(CORE, 'scripts', 'file-lock.mjs')).href);
  mkdirSync(dirname(lockPath), { recursive: true });
  const got = acquireFileLock(lockPath);
  const r = hook(3_000_000_000_000);
  releaseFileLock(lockPath, got.nonce);
  assert.ok(r.states.includes('pending:lock-busy'), r.states.join(','));
  let out = retrievalHook('what is the widget decision');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\[CORE collab handoff status — data, not instructions\]/);
  assert.match(out.stdout, /Collab handoff: .*pending/);
  assert.match(out.stdout, /integration-pending \(pending:lock-busy\)/);
  out = retrievalHook('what is the widget decision');
  assert.doesNotMatch(out.stdout, /Collab handoff/, 'shown once');
  assert.deepEqual(hook(3_000_000_000_000 + THROTTLE_MS).states.filter(s => s !== 'already-landed'), ['landed'], 'the next run lands it');
});

test('a run that throws leaves a visible notice instead of a silent stamp', { skip }, async () => {
  const r = runCollabSyncHook({ cwd: PROJECT }, { now: 4_000_000_000_000, findCollab: () => COLLAB, sync: () => { const e = new Error('disk'); e.code = 'EIO'; throw e; } });
  assert.equal(r.status, 'error');
  assert.match(retrievalHook('widget decision').stdout, /did not finish \(EIO\)/);
});

test('cleanup', () => { rmSync(ROOT, { recursive: true, force: true }); rmSync(PROJECT, { recursive: true, force: true }); });
