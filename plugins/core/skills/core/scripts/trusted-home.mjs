/**
 * trusted-home.mjs — the trust anchors every path-authority gate resolves from:
 * the user home, the workspace-id vocabulary, and canonical path containment.
 *
 * os.homedir() follows $HOME/$USERPROFILE, which a project-controlled hook
 * environment can point at an attacker directory carrying its own
 *.claude/settings.json.
 * os.userInfo() reads the OS account database (passwd on POSIX, the profile
 * registry on Windows) and ignores the environment entirely.
 *
 * Any authority check that resolves ~/.core from the environment is spoofable;
 * resolve it from here instead. Unresolvable → null → the caller must fail closed;
 * mutation paths call requireTrustedHome() and get a throw instead of a fallback.
 *
 * Containment is canonical, never lexical: realpath both operands and compare on
 * a separator boundary, so neither a symlink nor a sibling directory whose name
 * shares a prefix (…/user2 against …/user) can be promoted into a trusted tree.
 */
import { userInfo } from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';

export function trustedHome() {
  try { return userInfo().homedir || null; } catch { return null; }
}

/**
 * The trusted home, or a throw. Trust decisions and mutation destinations use
 * this: when the OS account home cannot be established there is no safe
 * substitute, and homedir() is exactly the value the hardening exists to avoid.
 */
export function requireTrustedHome({ resolve: resolveHome = trustedHome } = {}) {
  const home = resolveHome();
  if (!home) {
    throw Object.assign(
      new Error('cannot establish the trusted OS-account home — refusing to resolve a trusted path from the environment'),
      { code: 'NO_TRUSTED_HOME' },
    );
  }
  return home;
}

// ---------- workspace identity ----------

/**
 * A workspace id names ONE directory segment beneath ~/.core/workspaces/. It
 * arrives from project-controlled workspace.json, so anything carrying a
 * separator, a drive prefix, or a leading dot is rejected before any path join.
 */
export const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeWorkspaceId(id) {
  return typeof id === 'string' && WORKSPACE_ID_RE.test(id);
}

export function assertSafeWorkspaceId(id) {
  if (!isSafeWorkspaceId(id)) {
    throw Object.assign(
      new Error(`unsafe workspace id ${JSON.stringify(id)} — an id names one directory segment matching ${WORKSPACE_ID_RE}`),
      { code: 'UNSAFE_WORKSPACE_ID' },
    );
  }
  return id;
}

// ---------- canonical path containment ----------

/**
 * Canonicalize `candidate` and require it to stay inside `root`; returns the
 * canonical absolute path, or null.
 *
 * Symlinks are followed on both sides before the comparison, so containment is
 * judged on the real target rather than the spelling. A destination that does
 * not exist yet is canonicalized through its nearest existing ancestor, so a
 * write target can be contained before it is created. The comparison is on a
 * separator boundary: a sibling that merely shares the root's prefix is out.
 */
export function containedPath(root, candidate) {
  let realRoot;
  try { realRoot = realpathSync(resolve(root)); } catch { return null; }

  let existing = resolve(candidate);
  const tail = [];
  for (;;) {
    try { existing = realpathSync(existing); break; }
    catch {
      const parent = dirname(existing);
      if (parent === existing) return null; // walked past the filesystem root
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  const full = tail.length ? join(existing, ...tail) : existing;
  if (full !== realRoot && !full.startsWith(realRoot + sep)) return null;
  return full;
}

/**
 * A trusted read must land on a regular file inside `root` — not a directory, a
 * device, a fifo, or a link whose target escapes the tree. Returns the canonical
 * path, or null.
 */
export function regularFileWithin(root, candidate) {
  const full = containedPath(root, candidate);
  if (!full) return null;
  try { if (!lstatSync(full).isFile()) return null; } catch { return null; }
  return full;
}
