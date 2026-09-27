// Adopting another install's CORE state: a project restored from backup onto a new
// machine or path is offered once; yes carries its history, no touches nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, cpSync, statSync, existsSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerProject, recordBootstrap, readBootstrapRecord, main as registryMain } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import {
  readManifest, updateManifest, classifyStamp, adoptionCandidate, adoptForeignState,
} from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { checkMetricsDisclosure } from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';
import { metricsEnabled } from '../../plugins/core/skills/core/scripts/log-event.mjs';

const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));
const HOOKS = fileURLToPath(new URL('../../plugins/core/skills/core/hooks/', import.meta.url));
const H = 'claude-code';
const ENV = { CORE_HARNESS: H };

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'adopt-'))));
  const home = (name) => { const h = join(base, name); mkdirSync(join(h, '.core'), { recursive: true }); return h; };
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, home, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function treeHashes(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(dir, f)] = createHash('sha256').update(readFileSync(f)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** A project that lived under install A, then its archive restored at a new path under install B. */
function restoredProject(s, manifestFields = { agent_name: 'Wren' }) {
  const homeA = s.home('homeA');
  const coreA = join(homeA, '.core');
  const original = s.mk('Old', 'Garden');
  registerProject(coreA, original);
  const m = updateManifest({ root: original, harness: H, coreDir: coreA, fields: manifestFields });
  recordBootstrap(coreA, { root: original, harness: H, sessionStartedAt: '2026-09-20T10:00:00Z' });
  writeFileSync(join(original, '.core', H, 'capability-history.jsonl'), '{"row":1}\n{"row":2}\n');
  const homeB = s.home('homeB');
  const coreB = join(homeB, '.core');
  const restored = join(s.base, 'New', 'Garden');
  cpSync(original, restored, { recursive: true });
  rmSync(original, { recursive: true, force: true });
  return { homeB, coreB, restored, original, project_id: m.project_id };
}

test('restore, yes: history, project_id and agent_name carry over, and the signed files verify', () => {
  const s = sandbox();
  try {
    const { homeB, coreB, restored, original, project_id } = restoredProject(s);
    const cand = adoptionCandidate({ root: restored, harness: H, coreDir: coreB });
    assert.equal(cand.oldPath, original);
    assert.ok(cand.lastWritten, 'last-written date is offered');

    const r = adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'yes' });
    assert.equal(r.status, 'adopted');
    assert.equal(classifyStamp({ root: restored, harness: H, coreDir: coreB }).status, 'verified');
    const m = readManifest({ root: restored, harness: H, coreDir: coreB });
    assert.equal(m.project_id, project_id);
    assert.equal(m.agent_name, 'Wren');
    assert.equal(readBootstrapRecord(coreB, { root: restored, harness: H }).session_started_at, '2026-09-20T10:00:00Z');
    assert.equal(readFileSync(join(restored, '.core', H, 'capability-history.jsonl'), 'utf8'), '{"row":1}\n{"row":2}\n');
    assert.equal(registerProject(coreB, restored).action, 'registered');
    assert.equal(adoptionCandidate({ root: restored, harness: H, coreDir: coreB }), null, 'asked once');
    assert.equal(checkMetricsDisclosure({ projectDir: restored, home: homeB, env: ENV }).shown, true, 'the notice shows again on this machine');
  } finally { s.cleanup(); }
});

test('restore, no: nothing is read, the foreign files stay byte-identical, and it is never offered again', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredProject(s);
    const before = treeHashes(join(restored, '.core'));
    assert.equal(adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'no' }).status, 'declined');
    assert.deepEqual(treeHashes(join(restored, '.core')), before);
    assert.equal(adoptionCandidate({ root: restored, harness: H, coreDir: coreB }), null);
    assert.equal(readManifest({ root: restored, harness: H, coreDir: coreB }), null, 'the foreign manifest is not read');
    assert.equal(registerProject(coreB, restored, { offerAdopt: true, harness: H }).action, 'new', 'register proceeds normally after a no');
    assert.equal(readManifest({ root: restored, harness: H, coreDir: coreB }), null, 'still not read once registered');
    assert.deepEqual(treeHashes(join(restored, '.core')), before);
  } finally { s.cleanup(); }
});

test('register offers adoption instead of registering, and the CLI reports it', () => {
  const s = sandbox();
  try {
    const { coreB, restored, original } = restoredProject(s);
    const r = registerProject(coreB, restored, { offerAdopt: true, harness: H });
    assert.equal(r.action, 'adopt-ask');
    assert.equal(r.old_path, original);
    assert.equal(existsSync(join(coreB, 'projects.json')) ? readFileSync(join(coreB, 'projects.json'), 'utf8').includes(restored) : false, false, 'nothing was registered');
    const out = spawnSync(process.execPath, [join(SCRIPTS, 'index-registry.mjs'), 'adopt-status', '--root', restored, '--core-dir', coreB, '--harness', H], { encoding: 'utf8' });
    assert.match(out.stdout, new RegExp(`^adopt-ask old_path=${original.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} last_written=`));
    assert.equal(registryMain(['adopt', '--no', '--root', restored, '--core-dir', coreB, '--harness', H]), 0);
    const after = spawnSync(process.execPath, [join(SCRIPTS, 'index-registry.mjs'), 'adopt-status', '--root', restored, '--core-dir', coreB, '--harness', H], { encoding: 'utf8' });
    assert.equal(after.stdout.trim(), '(none)');
  } finally { s.cleanup(); }
});

test('a hostile clone with a well-formed foreign stamp and a disclosure-shown manifest: on no, the notice still shows', () => {
  const s = sandbox();
  try {
    const { homeB, coreB, restored } = restoredProject(s, { agent_name: 'Mallory', metrics_disclosure_shown: true, metrics_disclosure_version: 99 });
    adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'no' });
    registerProject(coreB, restored);
    assert.equal(checkMetricsDisclosure({ projectDir: restored, home: homeB, env: ENV }).shown, true);
  } finally { s.cleanup(); }
});

test('adoption never switches capture on: an adopted opt-out holds, and an adopted opt-in yields to a committed opt-out', () => {
  const s = sandbox();
  try {
    const off = restoredProject(s, { metrics_enabled: false });
    adoptForeignState({ root: off.restored, harness: H, coreDir: off.coreB, decision: 'yes' });
    assert.equal(readManifest({ root: off.restored, harness: H, coreDir: off.coreB }).metrics_enabled, false);
    assert.equal(metricsEnabled({ project: off.restored, env: ENV, home: off.homeB }), false);
  } finally { s.cleanup(); }
  const t = sandbox();
  try {
    const on = restoredProject(t, { metrics_enabled: true });
    writeFileSync(join(on.restored, 'workspace.json'), JSON.stringify({ metrics_enabled: false }));
    adoptForeignState({ root: on.restored, harness: H, coreDir: on.coreB, decision: 'yes' });
    assert.equal('metrics_enabled' in readManifest({ root: on.restored, harness: H, coreDir: on.coreB }), false);
    assert.equal(metricsEnabled({ project: on.restored, env: ENV, home: on.homeB }), false);
  } finally { t.cleanup(); }
});

test("this machine's own opt-out for the folder survives adopting a manifest that has none", () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredProject(s);
    updateManifest({ root: restored, harness: H, coreDir: coreB, fields: { metrics_enabled: false } });
    adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'yes' });
    assert.equal(readManifest({ root: restored, harness: H, coreDir: coreB }).metrics_enabled, false);
  } finally { s.cleanup(); }
});

test('an unparseable manifest is set aside on yes, not adopted', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredProject(s);
    writeFileSync(join(restored, '.core', H, 'workspace.json'), '{not json');
    assert.equal(adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'yes' }).status, 'adopted');
    assert.ok(readdirSync(join(restored, '.core', H)).some((n) => n.startsWith('workspace.json.unparseable-')));
    const m = readManifest({ root: restored, harness: H, coreDir: coreB });
    assert.equal(m, null, 'no manifest was adopted');
  } finally { s.cleanup(); }
});

test('a folder already registered here (a synced folder shared with another machine) is never an adoption candidate', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredProject(s);
    registerProject(coreB, restored);
    assert.equal(adoptionCandidate({ root: restored, harness: H, coreDir: coreB }), null);
    assert.equal(adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'yes' }).status, 'not-a-candidate');
    assert.equal(classifyStamp({ root: restored, harness: H, coreDir: coreB }).status, 'foreign-install');
  } finally { s.cleanup(); }
});

test('a stamp git tracks (committed state, not a restore) is never an adoption candidate', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredProject(s);
    assert.equal(spawnSync('git', ['-C', restored, 'init', '-q']).status, 0);
    assert.equal(spawnSync('git', ['-C', restored, 'add', '-f', '.core/claude-code/stamp']).status, 0);
    assert.equal(adoptionCandidate({ root: restored, harness: H, coreDir: coreB }), null);
  } finally { s.cleanup(); }
});

test("this install's own stamp at an unregistered path is not an adoption question", () => {
  const s = sandbox();
  try {
    const home = s.home('home');
    const core = join(home, '.core');
    const p = s.mk('Here', 'Proj');
    registerProject(core, p);
    updateManifest({ root: p, harness: H, coreDir: core, fields: { agent_name: 'Own' } });
    writeFileSync(join(core, 'projects.json'), '[]\n');
    assert.equal(adoptionCandidate({ root: p, harness: H, coreDir: core }), null);
  } finally { s.cleanup(); }
});

test('no hook or background script adopts: only project-state and the registry CLI name the adopt path', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      if (statSync(f).isDirectory()) { scan(f); continue; }
      if (!/\.(mjs|js|cjs|sh|ps1|json)$/.test(name)) continue;
      if (f === join(SCRIPTS, 'project-state.mjs') || f === join(SCRIPTS, 'index-registry.mjs')) continue;
      const text = readFileSync(f, 'utf8');
      if (/adoptForeignState|index-registry\.mjs['"]?[^\n]*\badopt\b/.test(text)) offenders.push(f);
    }
  };
  scan(HOOKS);
  scan(SCRIPTS);
  assert.deepEqual(offenders, []);
});

test('a symlinked .core is never an adoption candidate', { skip: process.platform === 'win32' }, () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredProject(s);
    const elsewhere = join(s.base, 'Elsewhere');
    cpSync(join(restored, '.core'), elsewhere, { recursive: true });
    rmSync(join(restored, '.core'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(restored, '.core'));
    assert.equal(adoptionCandidate({ root: restored, harness: H, coreDir: coreB }), null);
  } finally { s.cleanup(); }
});

test('on yes, an adopted disclosure-shown flag is dropped, so the notice shows once on this machine', () => {
  const s = sandbox();
  try {
    const { homeB, coreB, restored } = restoredProject(s, { agent_name: 'Wren', metrics_disclosure_shown: true, metrics_disclosure_version: 99 });
    adoptForeignState({ root: restored, harness: H, coreDir: coreB, decision: 'yes' });
    const m = readManifest({ root: restored, harness: H, coreDir: coreB });
    assert.equal(m.metrics_disclosure_shown, undefined);
    assert.equal(checkMetricsDisclosure({ projectDir: restored, home: homeB, env: ENV }).shown, true);
  } finally { s.cleanup(); }
});

test('the startup register verb answers adopt-ask (exit 5) and registers nothing', () => {
  const s = sandbox();
  try {
    const { coreB, restored, original } = restoredProject(s);
    const out = spawnSync(process.execPath, [join(SCRIPTS, 'index-registry.mjs'), 'register', restored, '--core-dir', coreB, '--harness', H], { encoding: 'utf8' });
    assert.equal(out.status, 5, out.stderr);
    const r = JSON.parse(out.stdout);
    assert.equal(r.action, 'adopt-ask');
    assert.equal(r.old_path, original);
    assert.equal(existsSync(join(coreB, 'projects.json')) ? readFileSync(join(coreB, 'projects.json'), 'utf8').includes(restored) : false, false);
  } finally { s.cleanup(); }
});

test('the home folder is never offered for adoption, even holding a foreign stamp', () => {
  const s = sandbox();
  try {
    const { homeB, coreB, restored } = restoredProject(s);
    const homeState = join(homeB, '.core', H);
    mkdirSync(homeState, { recursive: true });
    writeFileSync(join(homeState, 'stamp'), readFileSync(join(restored, '.core', H, 'stamp')));
    assert.equal(adoptionCandidate({ root: homeB, harness: H, coreDir: coreB }), null);
  } finally { s.cleanup(); }
});

// A build-time review's falsifier: every fixture above descends from a real writeStamp() /
// updateManifest() call (a legitimate prior install), then gets copied. That never
// exercises the actual attack this feature is exposed to — a folder that was never a
// real CORE install at all, hand-built to *look* like one. wellFormed() only checks
// shape (project-state.mjs), and a foreign stamp's hmac is never cryptographically
// checked — there is no shared secret to check it against. So oldPath/lastWritten are
// attacker-controlled display strings, not verified facts; the mitigation is the
// prompt disclosing that plainly (spec updated alongside this test), not a code gate.
// This proves the mechanism still degrades safely on a fully fabricated candidate.
test('a hand-built hostile stamp (never written by a real install) is offered with its attacker-controlled fields, and yes still only carries the intended inert data', () => {
  const s = sandbox();
  try {
    const homeB = s.home('homeB');
    const coreB = join(homeB, '.core');
    const target = s.mk('Target', 'Folder');
    const harnessDir = join(target, '.core', H);
    mkdirSync(harnessDir, { recursive: true });

    const hostileStamp = {
      path: '/nowhere/an-attacker-typed-this-path',
      harness: H,
      install_id: 'attacker-picked-id',
      hmac: 'a'.repeat(64), // shape-valid; never verified for a foreign install_id
    };
    writeFileSync(join(harnessDir, 'stamp'), JSON.stringify(hostileStamp, null, 2) + '\n');
    writeFileSync(join(harnessDir, 'workspace.json'), JSON.stringify({
      project_id: 'attacker-chosen-project-id', agent_name: 'Mallory', metrics_enabled: true,
    }));
    writeFileSync(join(harnessDir, 'last-bootstrap.json'), JSON.stringify({ session_started_at: '1999-01-01T00:00:00Z' }));

    const cand = adoptionCandidate({ root: target, harness: H, coreDir: coreB });
    assert.ok(cand, 'a merely well-formed hand-built stamp is offered — the display, never a code gate, is the safeguard');
    assert.equal(cand.oldPath, hostileStamp.path, 'oldPath is exactly the attacker string, unverified — this is what the prompt must disclose as such');

    const r = adoptForeignState({ root: target, harness: H, coreDir: coreB, decision: 'yes' });
    assert.equal(r.status, 'adopted');
    assert.equal(classifyStamp({ root: target, harness: H, coreDir: coreB }).status, 'verified', 'adoption re-stamps with THIS install\'s own secret; the fabricated install_id is never trusted afterward');
    const m = readManifest({ root: target, harness: H, coreDir: coreB });
    assert.equal(m.project_id, 'attacker-chosen-project-id', 'project_id is inert display data, carried over by design');
    assert.equal(m.agent_name, 'Mallory', 'agent_name is inert display data, carried over by design');
    assert.equal('metrics_enabled' in m, false, 'a hostile opt-in from a fully fabricated source is dropped, same as a copied one');
  } finally { s.cleanup(); }
});
