#!/usr/bin/env node
/**
 * one-folder-packet.mjs — the executable acceptance packet for the one-folder (project-only) runtime.
 *
 * Runs every entry point as a child process under the fs-confine gate with the project folder and this
 * checkout as the only allowed roots, twice: outside paths answered as unreadable (EACCES) and as absent
 * (ENOENT). Nothing outside the project is read or changed: the gate refuses the access before it happens,
 * so the machine's real ~/.core is never touched.
 *
 * Output: one JSON receipt (rows, raw operation logs, tree hashes, lock owners, negative controls) and a
 * markdown table. Exit 0 only when every `confined` row has zero violations, every `unsupported` row is
 * recorded as such, and every negative control produced its violation.
 *
 *   node tests/acceptance/one-folder-packet.mjs <out-dir>
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = join(REPO, 'plugins/core/skills/core');
const GATE = pathToFileURL(join(REPO, 'tests/scripts/fs-confine.mjs')).href;
const out = resolve(process.argv[2] || join(tmpdir(), 'one-folder-packet'));
mkdirSync(out, { recursive: true });

const sha = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== '';

function fixture(name) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `packet-${name}-`)));
  const root = join(base, 'proj');
  mkdirSync(join(root, '_memories'), { recursive: true });
  mkdirSync(join(root, '_metrics', 'turn-capture'), { recursive: true });
  writeFileSync(join(root, 'PROJECT.md'), '# P\n\n## State\n- widgets are blue\n');
  writeFileSync(join(root, 'inbox.md'), '');
  for (const [id, body] of [['dc-1-widgets', 'Widgets are blue.'], ['dc-2-gadgets', 'Gadgets are red, decided after the widget review.'], ['risk-1-paint', 'Paint supply may run short.']]) {
    writeFileSync(join(root, '_memories', `${id}.md`), `---\nid: ${id}\ntype: ${id.split('-')[0] === 'dc' ? 'decision' : 'risk'}\nstatus: active\ntopics: [widgets]\n---\n${body}\n`);
  }
  writeFileSync(join(root, '_metrics', 'turn-capture', '2026-10-01.jsonl'), '{"turn":1}\n');
  return { base, root };
}
const tree = (dir) => {
  const o = {};
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); n.isDirectory() ? walk(p) : (o[p.slice(dir.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex')); } };
  if (existsSync(dir)) walk(dir);
  return o;
};

function runConfined(root, errno, args, { input = '', cwd = root } = {}) {
  const log = join(out, `.log-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  const roots = [root, REPO].join(delimiter);
  return new Promise((done) => {
    const c = spawn(process.execPath, ['--import', GATE, ...args], { cwd, env: { ...process.env, FS_CONFINE_ROOTS: roots, FS_CONFINE_ERRNO: errno, FS_CONFINE_LOG: log } });
    let so = ''; let se = '';
    c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
    c.stdin.end(input);
    c.on('close', (status) => {
      const m = se.match(/FS_CONFINE_VIOLATIONS (.*)/);
      const ops = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      rmSync(log, { force: true });
      done({ status, stdout: so.trim(), violations: m ? JSON.parse(m[1]) : null, ops });
    });
  });
}

const PO = join(CORE, 'scripts/project-only.mjs');
const rows = [];
const add = (row) => rows.push(row);
const summarize = (r) => ({ exit: r.status, stdout: r.stdout.slice(0, 400), violations: r.violations, operations: r.ops.length, outside_attempts: r.ops.filter((o) => o.verdict !== 'allowed').length, raw_operations: r.ops });

for (const errno of ['EACCES', 'ENOENT']) {
  const { base, root } = fixture(errno);
  try {
    const before = tree(root);
    const step = async (id, entry, args, expect, opts) => {
      const r = await runConfined(root, errno, args, opts);
      const s = summarize(r);
      const ok = expect === 'confined' ? s.violations?.length === 0 && s.outside_attempts === 0
        : expect === 'unsupported' ? true : false;
      add({ id, entry, errno, expect, ...s, result: expect === 'unsupported' ? (s.outside_attempts ? 'unsupported-observed-outside-access' : 'unsupported-but-confined') : ok ? 'pass' : 'FAIL' });
      return r;
    };
    const po = (...a) => [PO, ...a, '--root', root];
    await step('startup', 'project-only.mjs startup', po('startup', '--session', 'pk-1'), 'confined');
    await step('status', 'project-only.mjs status', po('status'), 'confined');
    await step('capture-status', 'project-only.mjs capture-status', po('capture-status'), 'confined');
    await step('explicit-retrieval', 'retrieve-context.mjs <root> "<query>"', [join(CORE, 'scripts/retrieve-context.mjs'), root, 'what color are the widgets'], 'confined');
    await step('hook-user-prompt-submit', 'hooks/retrieve-context-hook.mjs (UserPromptSubmit)', [join(CORE, 'hooks/retrieve-context-hook.mjs')], 'confined', { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'what color are the widgets', session_id: 'pk-1' }) });
    await step('hook-session-end', 'hooks/close-pass-hook.mjs (SessionEnd)', [join(CORE, 'hooks/close-pass-hook.mjs')], 'confined', { input: JSON.stringify({ hook_event_name: 'SessionEnd', cwd: root, reason: 'other', session_id: 'pk-1' }) });
    await step('hook-session-start', 'hooks/session-start-hook.mjs (SessionStart)', [join(CORE, 'hooks/session-start-hook.mjs')], 'confined', { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: root, source: 'startup', session_id: 'pk-1' }) });
    for (const [i, a] of [['begin', ['finalize-begin', '--session', 'pk-1']], ['record-capture', ['finalize-record', '--session', 'pk-1', '--op', 'material-capture', '--status', 'done']], ['record-render', ['finalize-record', '--session', 'pk-1', '--op', 'render-project-md', '--status', 'done']], ['record-summary', ['finalize-record', '--session', 'pk-1', '--op', 'session-summary', '--status', 'done']], ['certify', ['finalize-certify', '--session', 'pk-1']], ['finish', ['finalize-finish', '--session', 'pk-1']]]) {
      await step(`finalize-${i}`, `project-only.mjs ${a[0]}`, po(...a), 'confined');
    }
    await step('purge', 'project-only.mjs purge', po('purge'), 'confined');
    await step('pickup', 'project-only.mjs pickup (normal-session read)', po('pickup'), 'confined');
    // Unsupported in this mode: observed, not claimed. Each shows what still reaches outside the folder.
    await step('maintenance-run', 'maintenance-run.mjs <root> (housekeeping)', [join(CORE, 'scripts/maintenance-run.mjs'), root, '--json'], 'unsupported');
    await step('close-pass-detect', 'close-pass.mjs detect <root> (normal close bookkeeping)', [join(CORE, 'scripts/close-pass.mjs'), 'detect', root], 'unsupported');
    await step('pickup-archive', 'project-only.mjs pickup-archive', po('pickup-archive'), 'confined');
    const after = tree(root);
    const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f]);
    add({ id: 'project-tree-delta', errno, expect: 'info', files_changed_or_added: changed, result: 'recorded' });
  } finally { rmSync(base, { recursive: true, force: true }); }
}

// Two projects at once, both modes: distinct lock files and owners, both certify, no cross-tree change.
for (const errno of ['EACCES', 'ENOENT']) {
  const A = fixture('A'); const B = fixture('B');
  try {
    const lockOwner = (root) => {
      const mem = join(root, '_memories');
      return readdirSync(mem).filter((n) => n.includes('_close.lock')).map((n) => { try { const j = JSON.parse(readFileSync(join(mem, n), 'utf8')); return { file: n, session_id: j.session_id, nonce: j.nonce }; } catch { return { file: n, unreadable: true }; } });
    };
    const cycle = async (root, session, held) => {
      const res = [];
      const go = async (...a) => { const r = await runConfined(root, errno, [PO, ...a, '--session', session, '--root', root]); res.push(r); return JSON.parse(r.stdout); };
      await go('startup');
      await go('finalize-begin'); held.owner = lockOwner(root);
      for (const op of ['material-capture', 'render-project-md', 'session-summary']) await go('finalize-record', '--op', op, '--status', 'done');
      const c = await go('finalize-certify'); const f = await go('finalize-finish');
      return { certified: c.outcome, released: f.released, violations: res.flatMap((r) => r.violations || []), operations: res.reduce((n, r) => n + r.ops.length, 0) };
    };
    const bBefore = tree(B.root); const aBefore = tree(A.root);
    const ha = {}; const hb = {};
    const [ra, rb] = await Promise.all([cycle(A.root, 'sa', ha), cycle(B.root, 'sb', hb)]);
    const aOnly = Object.keys(tree(A.root)).filter((f) => !(f in aBefore)); const bOnly = Object.keys(tree(B.root)).filter((f) => !(f in bBefore));
    const noCross = !aOnly.some((f) => f.includes('sb')) && !bOnly.some((f) => f.includes('sa'));
    const distinct = ha.owner?.[0]?.nonce && hb.owner?.[0]?.nonce && ha.owner[0].nonce !== hb.owner[0].nonce && ha.owner[0].session_id === 'sa' && hb.owner[0].session_id === 'sb';
    const ok = ra.certified === 'partial' && rb.certified === 'partial' && ra.violations.length === 0 && rb.violations.length === 0 && noCross && distinct;
    add({ id: 'two-projects-concurrent-finalize', entry: 'project-only.mjs, projects A and B at the same time', errno, expect: 'confined', A: ra, B: rb, lock_owners: { A: ha.owner, B: hb.owner }, files_added: { A: aOnly, B: bOnly }, final_hashes: { A: tree(A.root), B: tree(B.root) }, result: ok ? 'pass' : 'FAIL' });
  } finally { rmSync(A.base, { recursive: true, force: true }); rmSync(B.base, { recursive: true, force: true }); }
}

// Negative controls: each must make a confinement or lock-separation claim fail.
const controls = [];
{
  const { base, root } = fixture('neg');
  try {
    const home = userInfo().homedir;
    const probe = (code) => runConfined(root, 'EACCES', ['--input-type=module', '-e', code]);
    const lockImport = pathToFileURL(join(CORE, 'scripts/file-lock.mjs')).href;
    const c1 = await probe(`import { acquireFileLock, releaseFileLock } from ${JSON.stringify(lockImport)}; const l = acquireFileLock(${JSON.stringify(join(root, '_memories', '_neg.lock'))}, {}); if (l.ok) releaseFileLock(${JSON.stringify(join(root, '_memories', '_neg.lock'))}, l.nonce);`);
    controls.push({ id: 'N1-global-identity-lock-reintroduced', what: 'a lock taken without the no-identity declaration reads the install id', expected: 'violation on install-id', violations: c1.violations, result: c1.violations?.some((v) => v.path.endsWith('install-id')) ? 'pass (the packet would fail)' : 'FAIL (control did not trigger)' });
    const c2 = await probe(`import { readFileSync } from 'node:fs'; try { readFileSync(${JSON.stringify(join(home, '.core', 'install-id'))}); } catch {}`);
    controls.push({ id: 'N2-direct-home-read', what: 'code that reads ~/.core directly is recorded and refused', expected: 'violation on ~/.core', violations: c2.violations, result: c2.violations?.some((v) => v.path.includes('.core')) ? 'pass (the packet would fail)' : 'FAIL (control did not trigger)' });
    await runConfined(root, 'EACCES', [PO, 'finalize-begin', '--session', 'n3a', '--root', root]);
    const c3 = await runConfined(root, 'EACCES', [PO, 'finalize-begin', '--session', 'n3b', '--root', root]);
    const j = JSON.parse(c3.stdout);
    controls.push({ id: 'N3-same-project-lock-separation', what: 'a second close on the same project is refused while the first holds the lock', expected: 'lock-held', observed: j.state, result: j.state === 'lock-held' ? 'pass (separation is real: the same project contends)' : 'FAIL' });
    // The hook rows above pass because the project-only folder makes the hooks exit first. Without that
    // folder the same hook, same payload, reaches the registry in the account home: the rows are not vacuous.
    const plain = fixture('nohint');
    try {
      const c4 = await runConfined(plain.root, 'EACCES', [join(CORE, 'hooks/retrieve-context-hook.mjs')], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: plain.root, prompt: 'what color are the widgets', session_id: 'n4' }) });
      controls.push({ id: 'N4-hook-without-project-only-folder', what: 'the automatic retrieval hook, run in a folder without the project-only marker, reaches outside the folder', expected: 'outside attempt recorded', outside_attempts: c4.ops.filter((o) => o.verdict !== 'allowed').length, violations: c4.violations, result: c4.violations?.length ? 'pass (the hook rows are not vacuous)' : 'FAIL (control did not trigger)' });
    } finally { rmSync(plain.base, { recursive: true, force: true }); }
  } finally { rmSync(base, { recursive: true, force: true }); }
}

const failed = rows.filter((r) => r.result === 'FAIL').length + controls.filter((c) => c.result.startsWith('FAIL')).length;
const receipt = { pinned_sha: sha, working_tree_dirty: dirty, node: process.version, platform: `${process.platform} ${process.arch}`, ran_at: new Date().toISOString(), gate: 'tests/scripts/fs-confine.mjs (Node fs seam; child processes, native code and a real sandbox are outside it)', rows, negative_controls: controls, failed };
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const md = ['| row | errno | expectation | result | operations | outside attempts |', '|---|---|---|---|---|---|', ...rows.filter((r) => r.operations !== undefined).map((r) => `| ${r.id} | ${r.errno} | ${r.expect} | ${r.result} | ${r.operations} | ${r.outside_attempts} |`), ...rows.filter((r) => r.id === 'two-projects-concurrent-finalize').map((r) => `| ${r.id} | ${r.errno} | ${r.expect} | ${r.result} | ${r.A.operations + r.B.operations} | ${r.A.violations.length + r.B.violations.length} |`), '', ...controls.map((c) => `- ${c.id}: ${c.result}`)].join('\n');
writeFileSync(join(out, 'summary.md'), md + '\n');
process.stdout.write(`${md}\n\npinned ${sha}${dirty ? ' (DIRTY TREE)' : ''}; failed: ${failed}; receipt: ${join(out, 'receipt.json')}\n`);
process.exitCode = failed ? 1 : 0;
