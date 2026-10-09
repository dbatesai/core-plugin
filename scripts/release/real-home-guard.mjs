#!/usr/bin/env node
/**
 * CI guard: the test suite must not write into the real account's ~/.core.
 *
 *   node real-home-guard.mjs snapshot <file> [--home <dir>]   record every entry under <home>/.core
 *   node real-home-guard.mjs check <file> [--home <dir>]      fail (exit 1) if anything was added, removed or changed
 *
 * The account home is the OS account record's, the same one CORE resolves; `--home` is for this
 * guard's own test. Entries under `.test-tmp/` (the shared test root, cleaned by its tests) are not
 * counted, and BASELINE names writes that existing tests still make, so each one is visible here
 * until it is converted.
 */
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

// Names this tree's suite is known to write (close-hook-regression-parent-sha and close-index-path-validation
// write close-pass-last.log), and the global stamp lock that an older installed version's hooks take on a
// developer machine while the suite runs. Neither is allowed to grow without a line here.
export const BASELINE = [/^close-pass-last\.log$/, /^\.?state-cache\.lock(\.|$)/];

export function snapshot(home) {
  const root = join(home, '.core');
  const out = {};
  const walk = (dir, rel) => {
    let names;
    try { names = readdirSync(dir); } catch (e) { if (rel) out[`${rel}/`] = `unreadable:${e.code}`; else out['.'] = `unreadable:${e.code}`; return; }   // an unreadable folder is a recorded state, never an empty one
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === '.test-tmp' || BASELINE.some((re) => re.test(r))) continue;
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      out[r] = st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p, r);
    }
  };
  walk(root, '');
  return out;
}

export function diff(before, after) {
  const problems = [];
  for (const k of Object.keys(after)) if (!(k in before)) problems.push(`added: ${k}`);
  for (const k of Object.keys(before)) {
    if (!(k in after)) problems.push(`removed: ${k}`);
    else if (before[k] !== after[k] && before[k] !== 'dir') problems.push(`changed: ${k}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--home');
  const home = at >= 0 ? rest[at + 1] : userInfo().homedir;
  if (cmd === 'snapshot' && file) { writeFileSync(file, JSON.stringify(snapshot(home))); process.exit(0); }
  if (cmd === 'check' && file) {
    const problems = diff(JSON.parse(readFileSync(file, 'utf8')), snapshot(home));
    if (problems.length) {
      // ~/.core that did not exist before can come back holding only names the snapshot skips: name everything in it.
      let made = '';
      if (problems.includes('removed: .')) { try { made = `\n  ~/.core now exists, holding: ${readdirSync(join(home, '.core')).join(', ') || '(nothing)'}`; } catch { /* still absent */ } }
      process.stderr.write(`the test suite changed the real account ~/.core (${home}):\n  ${problems.join('\n  ')}${made}\n`); process.exit(1);
    }
    process.stdout.write('real ~/.core untouched\n'); process.exit(0);
  }
  process.stderr.write('usage: real-home-guard.mjs snapshot|check <file> [--home <dir>]\n'); process.exit(2);
}
