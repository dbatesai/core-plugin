// Turns the result of an `icacls /remove:d` spawn into null (restored) or a one-line description of why it was not.
export function restoreProblem(r) {
  if (r && !r.error && r.status === 0) return null;
  const why = r?.error ? r.error.message : `exit ${r?.status ?? 'unknown'}: ${String(r?.stderr || r?.stdout || '').trim()}`;
  return `icacls /remove:d did not restore the folder (${why})`;
}
