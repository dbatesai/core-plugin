// Turns the result of an `icacls /remove:d` spawn into null (restored) or a one-line description of why it was not.
export function restoreProblem(r) {
  if (r && !r.error && r.status === 0) return null;
  const why = r?.error ? r.error.message : `exit ${r?.status ?? 'unknown'}: ${String(r?.stderr || r?.stdout || '').trim()}`;
  return `icacls /remove:d did not restore the folder (${why})`;
}

// Denies the Windows account's new-entry rights on `dir` and returns the restore closure (null on success, or why not).
// The removal is also attempted when the deny itself reports failure, since an ACL entry may already have been applied;
// the setup error is kept as the thrown error and a failed compensating removal is named beside it.
export function denyWithCompensation(run, dir, account, rights) {
  const undo = () => restoreProblem(run('icacls', [dir, '/remove:d', account], { encoding: 'utf8' }));
  const r = run('icacls', [dir, '/deny', `${account}:${rights}`], { encoding: 'utf8' });
  if (r && !r.error && r.status === 0) return undo;
  const why = r?.error ? r.error.message : (r?.stderr || r?.stdout || `exit ${r?.status ?? 'unknown'}`);
  const stuck = undo();
  throw new Error(`icacls deny failed: ${why}${stuck ? `; the compensating removal also failed: ${stuck}` : ''}`);
}
