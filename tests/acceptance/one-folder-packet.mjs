#!/usr/bin/env node
/**
 * one-folder-packet.mjs — the executable acceptance packet for the one-folder (project-only) runtime.
 *
 * Runs every entry point as a child process under the fs-confine gate with the project folder and this
 * checkout as the only allowed roots, twice: outside paths answered as unreadable (EACCES) and as absent
 * (ENOENT). Nothing outside the project is read or changed: the gate refuses the access before it happens,
 * so the machine's real ~/.core is never touched.
 *
 * Each row is judged twice, separately: confinement (no outside attempt) and outcome (exit code, reported
 * state, material effect). A run with no resolvable source pin fails; pass `--pin <sha>` for an exported archive.
 *
 * Output: one JSON receipt (rows, raw operation logs, tree hashes, lock owners, negative controls) and a
 * markdown table. Exit 0 only when every `confined` row has zero violations, every `unsupported` row is
 * recorded as such, and every negative control produced its violation.
 *
 *   node tests/acceptance/one-folder-packet.mjs <out-dir>
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = join(REPO, 'plugins/core/skills/core');
const GATE = pathToFileURL(join(REPO, 'tests/scripts/fs-confine.mjs')).href;
const out = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(tmpdir(), 'one-folder-packet'));
mkdirSync(out, { recursive: true });

const sha = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const porcelain = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' });
// A run that can't name its own source is not a pinned packet: pass --pin <sha> for an exported archive.
const pinArg = process.argv.indexOf('--pin') >= 0 ? process.argv[process.argv.indexOf('--pin') + 1] : null;
const provenance = /^[0-9a-f]{40}$/.test(sha) && porcelain.status === 0 ? 'git' : /^[0-9a-f]{40}$/.test(pinArg || '') ? 'declared' : 'missing';
const dirty = provenance === 'git' ? porcelain.stdout.trim() !== '' : null;

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
    // A row passes on TWO separate checks: confinement (no outside attempt) and outcome (the operation
    // did what the row says: exit code, reported state, and where named a material effect in the tree).
    const step = async (id, entry, args, expect, opts = {}) => {
      const r = await runConfined(root, errno, args, opts);
      const s = summarize(r);
      let parsed = null; try { parsed = JSON.parse(r.stdout.split('\n').pop()); } catch { /* not JSON */ }
      const want = opts.outcome || {};
      const problems = [];
      if (expect !== 'unsupported') {
        if (want.exit !== undefined && r.status !== want.exit) problems.push(`exit ${r.status}, wanted ${want.exit}`);
        if (want.status !== undefined && parsed?.status !== want.status) problems.push(`status ${parsed?.status}, wanted ${want.status}`);
        if (want.stdout && !want.stdout.test(r.stdout)) problems.push(`stdout did not match ${want.stdout}`);
        if (want.emptyStdout && r.stdout !== '') problems.push('stdout was not empty');
        for (const f of want.files || []) if (!existsSync(join(root, f))) problems.push(`missing effect: ${f}`);
        if (want.check) { const why = want.check(parsed, r); if (why) problems.push(why); }
        if (!Object.keys(want).length) problems.push('row has no outcome expectation');
      }
      const confinedOk = s.violations?.length === 0 && s.outside_attempts === 0;
      const result = expect === 'unsupported' ? (s.outside_attempts ? 'unsupported-observed-outside-access' : 'unsupported-but-confined')
        : confinedOk && !problems.length ? 'pass' : 'FAIL';
      add({ id, entry, errno, expect, confinement: confinedOk ? 'confined' : 'outside-access', outcome: problems.length ? problems : 'as-expected', ...s, result });
      return r;
    };
    const po = (...a) => [PO, ...a, '--root', root];
    await step('startup', 'project-only.mjs startup', po('startup', '--session', 'pk-1'), 'confined', { outcome: { exit: 0, status: 'ok', files: ['.core/.gitignore', '.core/_project-only/claude-code/bootstrap.json'] } });
    await step('status', 'project-only.mjs status', po('status'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (j?.pending === true ? null : 'pending not reported') } });
    await step('capture-status', 'project-only.mjs capture-status', po('capture-status'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (j?.in_project?.rows === 1 && j?.outside_history === 'unknown' ? null : 'capture rows or outside-history wrong') } });
    await step('explicit-retrieval', 'retrieve-context.mjs <root> "<query>"', [join(CORE, 'scripts/retrieve-context.mjs'), root, 'what color are the widgets'], 'confined', { outcome: { exit: 0, stdout: /dc-1-widgets/ } });
    await step('hook-user-prompt-submit', 'hooks/retrieve-context-hook.mjs (UserPromptSubmit)', [join(CORE, 'hooks/retrieve-context-hook.mjs')], 'confined', { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'what color are the widgets', session_id: 'pk-1' }) , outcome: { exit: 0, emptyStdout: true } });
    await step('hook-session-end', 'hooks/close-pass-hook.mjs (SessionEnd)', [join(CORE, 'hooks/close-pass-hook.mjs')], 'confined', { input: JSON.stringify({ hook_event_name: 'SessionEnd', cwd: root, reason: 'other', session_id: 'pk-1' }) , outcome: { exit: 0, emptyStdout: true } });
    await step('hook-session-start', 'hooks/session-start-hook.mjs (SessionStart)', [join(CORE, 'hooks/session-start-hook.mjs')], 'confined', { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: root, source: 'startup', session_id: 'pk-1' }) , outcome: { exit: 0, stdout: /project-only/i } });
    for (const [i, a] of [['begin', ['finalize-begin', '--session', 'pk-1']], ['record-capture', ['finalize-record', '--session', 'pk-1', '--op', 'material-capture', '--status', 'done']], ['record-render', ['finalize-record', '--session', 'pk-1', '--op', 'render-project-md', '--status', 'done']], ['record-summary', ['finalize-record', '--session', 'pk-1', '--op', 'session-summary', '--status', 'done']], ['certify', ['finalize-certify', '--session', 'pk-1']], ['finish', ['finalize-finish', '--session', 'pk-1']]]) {
      await step(`finalize-${i}`, `project-only.mjs ${a[0]}`, po(...a), 'confined', { outcome: { exit: 0, status: 'ok', files: i === 'certify' ? ['.core/_project-only/claude-code/close/receipts/pk-1.json'] : [] } });
    }
    await step('purge-dry-run', 'project-only.mjs purge', po('purge'), 'confined', { outcome: { exit: 0, status: 'ok', files: ['_metrics/turn-capture/2026-10-01.jsonl'], check: (j) => (j?.outcome === 'dry-run' && j.would_remove?.includes('_metrics/turn-capture') && j.outside_history === 'unknown' ? null : 'dry run report wrong') } });
    await step('purge-apply', 'project-only.mjs purge --apply', po('purge', '--apply'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (j?.outcome === 'purged-in-project' && j.outside_history === 'unknown' && !existsSync(join(root, '_metrics/turn-capture')) && existsSync(join(root, '_memories/dc-1-widgets.md')) ? null : 'purge did not remove the captured turns, or removed more') } });
    await step('process-memory-dry-run', 'project-only.mjs process-memory', po('process-memory'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (j?.applied === false && j.units_checked === 3 && !existsSync(join(root, '_memories/INDEX-decisions.md')) ? null : 'dry run wrote an index or miscounted units') } });
    await step('process-memory-apply', 'project-only.mjs process-memory --apply', po('process-memory', '--apply'), 'confined', { outcome: { exit: 0, status: 'ok', files: ['_memories/INDEX-decisions.md', '_memories/INDEX-risks.md', '_memories/_lib/unit-summaries.json'], check: (j) => (j?.upkeep?.ran?.includes('summary-index') && j.not_run?.length === 5 && !existsSync(join(root, '_metrics/scorecard-log.jsonl')) ? null : 'indexes not regenerated, or derived metrics ran') } });
    await step('retention-dry-run', 'project-only.mjs retention', po('retention'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (['dry-run', 'nothing-in-project'].includes(j?.outcome) ? null : 'retention report wrong') } });
    for (const name of ['metrics', 'metrics-export', 'configure-project', 'memory-view']) await step(`unavailable-${name}`, `project-only.mjs ${name}`, po(name), 'confined', { outcome: { exit: 2, status: 'unavailable' } });
    await step('pickup', 'project-only.mjs pickup (normal-session read)', po('pickup'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (j?.pending === true && j.partial_closes?.[0]?.session_id === 'pk-1' && j.adopted?.completion === false ? null : 'pickup report wrong') } });
    // Unsupported in this mode: observed, not claimed. Each shows what still reaches outside the folder.
    await step('maintenance-run', 'maintenance-run.mjs <root> (housekeeping)', [join(CORE, 'scripts/maintenance-run.mjs'), root, '--json'], 'unsupported');
    await step('close-pass-detect', 'close-pass.mjs detect <root> (normal close bookkeeping)', [join(CORE, 'scripts/close-pass.mjs'), 'detect', root], 'unsupported');
    await step('pickup-archive', 'project-only.mjs pickup-archive', po('pickup-archive'), 'confined', { outcome: { exit: 0, status: 'ok', check: (j) => (j?.archived === true && !existsSync(join(root, '.core/_project-only/claude-code')) ? null : 'not archived') } });
    // After pickup the automatic hooks are no longer suppressed: the same hook now goes on to look the
    // project up in the registry, which under this gate shows as an outside attempt.
    const post = await runConfined(root, errno, [join(CORE, 'hooks/retrieve-context-hook.mjs')], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'what color are the widgets', session_id: 'pk-2' }) });
    add({ id: 'post-pickup-hook-not-suppressed', entry: 'hooks/retrieve-context-hook.mjs after pickup-archive', errno, expect: 'reaches-registry', ...summarize(post), result: post.violations?.length ? 'pass' : 'FAIL' });
    // Static links that arrive with the folder: explicit retrieval refuses them before any outside access.
    if (process.platform !== 'win32') {
      const RC = join(CORE, 'scripts/retrieve-context.mjs');
      const refusal = { outcome: { exit: 3, check: (_j, r) => (/dc-9-planted/.test(r.stdout) ? 'outside unit returned' : null) } };
      const la = fixture(`${errno}-linkmem`);
      const outsideStore = join(la.base, 'outside-store'); mkdirSync(outsideStore);
      writeFileSync(join(outsideStore, 'dc-9-planted.md'), '---\nid: dc-9-planted\ntype: decision\nstatus: active\n---\nSynthetic widget colour is purple.\n');
      rmSync(join(la.root, '_memories'), { recursive: true }); symlinkSync(outsideStore, join(la.root, '_memories'));
      const lb = fixture(`${errno}-linklib`);
      const outsideLib = join(lb.base, 'outside-lib'); mkdirSync(outsideLib);
      symlinkSync(outsideLib, join(lb.root, '_memories', '_lib'));
      const stepIn = async (fx, id, entry) => { const saved = root; const r = await runConfined(fx.root, errno, [RC, fx.root, 'synthetic widget colour']); const s2 = summarize(r); const why = refusal.outcome.check(null, r); const problems = [...(r.status !== 3 ? [`exit ${r.status}, wanted 3`] : []), ...(why ? [why] : [])]; const confinedOk = s2.violations?.length === 0 && s2.outside_attempts === 0; add({ id, entry, errno, expect: 'refused-before-outside-access', confinement: confinedOk ? 'confined' : 'outside-access', outcome: problems.length ? problems : 'as-expected', ...s2, result: confinedOk && !problems.length ? 'pass' : 'FAIL' }); void saved; };
      try {
        await stepIn(la, 'explicit-retrieval-linked-store', 'retrieve-context.mjs, _memories is a link out of the project');
        await stepIn(lb, 'explicit-retrieval-linked-lib', 'retrieve-context.mjs, _memories/_lib is a link out of the project');
        if (readdirSync(outsideLib).length) add({ id: 'explicit-retrieval-linked-lib-wrote-outside', errno, expect: 'nothing written outside', result: 'FAIL' });
      } finally { rmSync(la.base, { recursive: true, force: true }); rmSync(lb.base, { recursive: true, force: true }); }
    }
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

const failed = rows.filter((r) => r.result === 'FAIL').length + controls.filter((c) => c.result.startsWith('FAIL')).length + (provenance === 'missing' ? 1 : 0);
const receipt = { pinned_sha: provenance === 'git' ? sha : provenance === 'declared' ? pinArg : null, provenance, working_tree_dirty: dirty, node: process.version, platform: `${process.platform} ${process.arch}`, ran_at: new Date().toISOString(), gate: 'tests/scripts/fs-confine.mjs (Node fs seam; child processes, native code and a real sandbox are outside it)', rows, negative_controls: controls, failed };
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const md = ['| row | errno | expectation | result | confinement | outcome | operations | outside attempts |', '|---|---|---|---|---|---|---|---|', ...rows.filter((r) => r.operations !== undefined).map((r) => `| ${r.id} | ${r.errno} | ${r.expect} | ${r.result} | ${r.confinement || '-'} | ${Array.isArray(r.outcome) ? r.outcome.join('; ') : r.outcome || '-'} | ${r.operations} | ${r.outside_attempts} |`), ...rows.filter((r) => r.id === 'two-projects-concurrent-finalize').map((r) => `| ${r.id} | ${r.errno} | ${r.expect} | ${r.result} | - | both certified partial | ${r.A.operations + r.B.operations} | ${r.A.violations.length + r.B.violations.length} |`), '', ...controls.map((c) => `- ${c.id}: ${c.result}`)].join('\n');
writeFileSync(join(out, 'summary.md'), md + '\n');
process.stdout.write(`${md}\n\npinned ${receipt.pinned_sha || 'UNRESOLVED (packet fails: no source pin)'} [${provenance}]${dirty ? ' (DIRTY TREE)' : ''}; failed: ${failed}; receipt: ${join(out, 'receipt.json')}\n`);
process.exitCode = failed ? 1 : 0;
