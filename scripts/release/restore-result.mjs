// Control characters (newlines included) become single spaces, so a diagnostic stays on one line.
export const oneLine = (x) => String(x ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

// Turns the result of an `icacls /remove:d` spawn into null (restored) or a one-line description of why it was not.
export function restoreProblem(r) {
  if (r && !r.error && r.status === 0) return null;
  const why = r?.error ? oneLine(r.error.message) : `exit ${r?.status ?? 'unknown'}: ${oneLine(r?.stderr || r?.stdout)}`;
  return `icacls /remove:d did not restore the folder (${why})`;
}

// Denies the Windows account's new-entry rights on `dir` and returns the restore closure (null on success, or why not).
// The removal is also attempted when the deny itself reports failure, since an ACL entry may already have been applied;
// the setup error is kept as the thrown error and a failed compensating removal is named beside it.
export function denyWithCompensation(run, dir, account, rights) {
  const undo = () => restoreProblem(run('icacls', [dir, '/remove:d', account], { encoding: 'utf8' }));
  const r = run('icacls', [dir, '/deny', `${account}:${rights}`], { encoding: 'utf8' });
  if (r && !r.error && r.status === 0) return undo;
  const why = oneLine(r?.error ? r.error.message : (r?.stderr || r?.stdout || `exit ${r?.status ?? 'unknown'}`));
  const stuck = undo();
  throw new Error(`icacls deny failed: ${why}${stuck ? `; the compensating removal also failed: ${stuck}` : ''}`);
}

// A failure report: one line on stderr, and the process exit code becomes 1 only if it is not already nonzero (a failing test run keeps its own status).
export function reportFailure(proc, msg) {
  proc.stderr.write(`isolated suite: ${oneLine(msg)}\n`);
  proc.exitCode = proc.exitCode || 1;
}

// Last step of a run: restore the protected folder, then remove the temp home. Each failure is reported by name and neither hides the other.
export function cleanupTempHome({ restore, remove, home, report }) {
  const left = restore();
  if (left) report(left);
  try { remove(); } catch (e) { report(`the temporary home ${home} was left behind (${oneLine(e.message)})`); }
}
