/**
 * trusted-home.mjs — the single trusted user-home anchor for security gates.
 *
 * os.homedir() follows $HOME/$USERPROFILE, which a project-controlled hook
 * environment can point at an attacker directory carrying its own
 * .claude/settings.json (Hale's demonstrated bypass, 2026-07-11 re-review §5).
 * os.userInfo() reads the OS account database (passwd on POSIX, the profile
 * registry on Windows) and ignores the environment entirely.
 *
 * Any authority check that resolves ~/.core from the environment is spoofable;
 * resolve it from here instead. Unresolvable → null → the caller must fail closed.
 */
import { userInfo } from 'node:os';

export function trustedHome() {
  try { return userInfo().homedir || null; } catch { return null; }
}
