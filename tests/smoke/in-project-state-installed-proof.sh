#!/usr/bin/env bash
# in-project-state-installed-proof.sh — run the project-state migration and the startup
# commands that use it from a PACKAGED copy of the plugin (git archive of the committed
# tree, exactly as source-package-smoke.sh builds it), against a sandbox HOME and a sandbox
# project, and print commands, exit codes and before/after SHA-256 for the cases a reviewer
# asked to see: (a) faults during the copy and a held lock, (b) forged, truncated and
# git-tracked receipts, (c) a forged drift destination, (d) a clean migration and an
# old -> new -> old -> new rollback with once-only log import.
#
# What this does NOT prove: that the live installed plugin cache carries this build, or
# anything on Windows. The (a1) fault is chmod on POSIX (needs a non-root user) and an exclusive
# open handle through PowerShell on Windows; the Windows branches follow a reviewer's patched copy
# and have not been run by their author.
# Never touches a real HOME or project. Re-runnable. Usage:
#   bash tests/smoke/in-project-state-installed-proof.sh [<core-plugin-repo>]
# PROOF_REF=<commit> packages that commit instead of HEAD, so the same checks can be run against an older build and shown to fail.
# PROOF_PKG=<plugin root> runs the same checks from an already-installed plugin root instead of a fresh package.
set -u
REPO="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/core-state-proof-XXXX")"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1; SCRATCH="$(cygpath -m "$SCRATCH")" ;; *) IS_WIN=0 ;; esac  # Windows node cannot resolve Git Bash /tmp paths
PKG="$SCRATCH/plugin-root"
SCRIPTS="$PKG/skills/core/scripts"
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
cleanup() { chmod -R u+rwx "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT

if [ -n "${PROOF_PKG:-}" ]; then
  # An already-installed plugin root (for example the cache a throwaway CLAUDE_CONFIG_DIR installed).
  PKG="$PROOF_PKG"; SCRIPTS="$PKG/skills/core/scripts"
  [ -d "$SCRIPTS" ] || { echo "PROOF_PKG has no skills/core/scripts: $PKG"; exit 1; }
  echo "installed plugin root: $PKG"
  # The installed bytes must be the committed package's bytes, or none of the results below mean anything.
  mkdir -p "$SCRATCH/ref" && git -C "$REPO" -c core.autocrlf=false archive "${PROOF_REF:-HEAD}:plugins/core" | tar -x -C "$SCRATCH/ref" \
    || { echo "FAIL  cannot build the reference package for ${PROOF_REF:-HEAD}"; exit 1; }
  # On Windows an install can carry CRLF in files .gitattributes does not pin; only line endings are ignored there.
  DIFFOPT=""; [ "$IS_WIN" = 1 ] && DIFFOPT="--strip-trailing-cr"
  if diff -r $DIFFOPT "$SCRATCH/ref" "$PKG" >"$SCRATCH/identity.diff" 2>&1; then
    echo "byte-identical to the committed ${PROOF_REF:-HEAD} package: yes"
  else
    echo "FAIL  the installed root is NOT byte-identical to the committed ${PROOF_REF:-HEAD} package; stopping before any scenario"
    head -20 "$SCRATCH/identity.diff"; exit 1
  fi
else
  mkdir -p "$PKG"
  git -C "$REPO" -c core.autocrlf=false archive "${PROOF_REF:-HEAD}:plugins/core" | tar -x -C "$PKG" || { echo "package build failed"; exit 1; }
fi
echo "source commit: $(git -C "$REPO" rev-parse "${PROOF_REF:-HEAD}")"
echo "procedure sha256: $(sha "$0")"
[ "$(id -u)" = "0" ] && echo "NOTE: running as root, chmod faults will not fire"

# A fresh legacy install and one registered project per scenario.
new_world() {
  W="$SCRATCH/w$1"; export HOME="$W/home"; CORE="$HOME/.core"; PROJ="$HOME/Projects/Proj"
  mkdir -p "$CORE/workspaces/legacyid/metrics/classified" "$PROJ/_memories"
  printf '{"workspace_id":"legacyid","agent_name":"Plover"}' > "$CORE/workspaces/legacyid/workspace.json"
  printf '{"row":1}\n' > "$CORE/workspaces/legacyid/capability-history.jsonl"
  printf 'draft\n' > "$CORE/workspaces/legacyid/hot-section-draft.md"
  printf '{"state":"tier-0-win"}\n' > "$CORE/workspaces/legacyid/metrics/classified/2026-09-01.jsonl"
  printf '[{"workspace_id":"legacyid","name":"Proj","path":"%s"}]' "$PROJ" > "$CORE/index.json"
  printf '{"version":1,"entries":{"legacyid":{"harness":"claude-code","evidence":"proof"}}}' > "$CORE/migrate-harness-table.json"
  printf '{"workspace_id":"legacyid"}' > "$PROJ/workspace.json"
  export CLAUDECODE=1 CORE_HARNESS=claude-code
  STATE="$PROJ/.core/claude-code"; LEG="$CORE/workspaces/legacyid"
}
mig()   { node "$SCRIPTS/migrate-workspace-state.mjs" "$@" --root "$PROJ" --core-dir "$CORE"; }
statusof() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("no-json")}})'; }
tree_hashes() { (cd "$1" && find . -type f ! -name '.DS_Store' | sort | while read -r f; do echo "$(sha "$f")  $f"; done); }

echo; echo "== (d1) clean migration from the packaged copy, then a second run =="
new_world d1
before="$(tree_hashes "$LEG")"
OUT="$(mig --apply)"; rc=$?; echo "  \$ migrate-workspace-state.mjs --apply  -> exit $rc, status $(echo "$OUT" | statusof)"
[ $rc -eq 0 ] && [ "$(echo "$OUT" | statusof)" = migrated ] && ok "first run migrated" || bad "first run: $OUT"
[ "$(tree_hashes "$LEG" | grep -v MOVED.md)" = "$(echo "$before")" ] && ok "legacy source byte-identical (MOVED.md aside)" || bad "legacy source changed"
OUT="$(mig --apply)"; rc=$?; [ "$(echo "$OUT" | statusof)" = already-migrated ] && [ $rc -eq 0 ] && ok "second run already-migrated, exit 0" || bad "second run: $OUT"
[ -f "$STATE/migrated-from.json.mac" ] && ok "receipt is signed (.mac sidecar present)" || bad "no receipt MAC"

echo; echo "== (a1) copy fault after the stamp: an unreadable top-level file =="
new_world a1
if [ "$IS_WIN" = 1 ]; then
  WINF="$(cygpath -w "$LEG/hot-section-draft.md")"
  powershell.exe -NoProfile -Command "\$f=[System.IO.File]::Open('$WINF','Open','ReadWrite','None'); Write-Output held; Start-Sleep 20; \$f.Close()" > "$SCRATCH/a1.hold" &
  HOLDA1=$!; for i in 1 2 3 4 5 6 7 8 9 10; do grep -q held "$SCRATCH/a1.hold" 2>/dev/null && break; sleep 1; done
  echo "  fault: exclusive handle on hot-section-draft.md: $(cat "$SCRATCH/a1.hold" 2>/dev/null)"
else
  chmod 000 "$LEG/hot-section-draft.md"
fi
OUT="$(mig --apply 2>"$SCRATCH/a1.err")"; rc=$?; echo "  \$ --apply -> exit $rc; stderr: $(head -c 160 "$SCRATCH/a1.err")"
if [ "$IS_WIN" = 1 ]; then
  kill $HOLDA1 2>/dev/null; taskkill //F //T //PID "$(cat /proc/$HOLDA1/winpid 2>/dev/null)" >/dev/null 2>&1; wait $HOLDA1 2>/dev/null; sleep 1
else
  chmod 644 "$LEG/hot-section-draft.md"
fi
[ $rc -ne 0 ] && ok "startup sees a nonzero exit (marker fires)" || bad "fault exited 0"
[ ! -f "$STATE/migrated-from.json" ] && ok "no completion receipt" || bad "receipt written despite the fault"
[ -f "$STATE/.migrating" ] && ok ".migrating marker left in place" || bad "marker missing"
[ ! -f "$LEG/MOVED.md" ] && ok "old state not released" || bad "old state released"
M="$(node "$SCRIPTS/index-registry.mjs" manifest --root "$PROJ" --harness claude-code --core-dir "$CORE" 2>/dev/null)"; rc=$?
[ $rc -ne 0 ] && ok "a manifest reader sees nothing in the half-copied state (exit $rc)" || bad "reader consumed partial state: $M"
node "$SCRIPTS/index-registry.mjs" bootstrap --root "$PROJ" --harness claude-code --session-started 2026-09-28T00:00:00Z --core-dir "$CORE" >/dev/null 2>&1
[ ! -f "$STATE/last-bootstrap.json" ] && ok "the bootstrap receipt was not written into the half-copied state" || bad "bootstrap receipt landed in partial state"
OUT="$(mig --apply)"; [ "$(echo "$OUT" | statusof)" = migrated ] && [ ! -f "$STATE/.migrating" ] && ok "after repair the next run completes and clears the marker" || bad "retry: $OUT"

echo; echo "== (a2) held lock =="
new_world a2
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const { acquireFileLock } = await import(pathToFileURL('$SCRIPTS/file-lock.mjs').href);
const l = acquireFileLock('$PROJ/_memories/_close.lock', { extra: { session_id: 'proof-holder' }, staleMs: 900000, hardStaleMs: 1800000 });
console.log(l.ok ? 'held' : 'not-acquired'); setTimeout(() => {}, 20000);" > "$SCRATCH/a2.lock" &
HOLDER=$!; sleep 1
OUT="$(mig --apply)"; rc=$?; echo "  \$ --apply while another process holds the close lock -> exit $rc, status $(echo "$OUT" | statusof)"
kill $HOLDER 2>/dev/null; wait $HOLDER 2>/dev/null
[ $rc -eq 3 ] && [ "$(echo "$OUT" | statusof)" = lock-held ] && ok "lock-held exits 3 with its JSON" || bad "lock case: rc=$rc $OUT"
[ ! -f "$STATE/migrated-from.json" ] && ok "nothing migrated under a held lock" || bad "migrated despite the lock"

echo; echo "== (b) forged, truncated and git-tracked receipts =="
new_world b1   # forged before any copy
mkdir -p "$STATE"; node -e "
import(require('url').pathToFileURL('$SCRIPTS/project-state.mjs').href).then(m=>{m.stateDir({root:'$PROJ',harness:'claude-code',coreDir:'$CORE',forWrite:true})})"
printf '{"complete":true}' > "$STATE/migrated-from.json"
OUT="$(mig --apply)"; rc=$?; echo "  forged {complete:true} -> exit $rc, status $(echo "$OUT" | statusof)"
[ $rc -eq 3 ] && [ "$(echo "$OUT" | statusof)" = receipt-unverified ] && ok "forged receipt refused" || bad "forged receipt: $OUT"
[ ! -f "$STATE/capability-history.jsonl" ] && [ ! -f "$STATE/hot/capability-history.jsonl" ] && ok "nothing was copied on the strength of the forged receipt" || bad "the forged receipt let a copy through or a file was signed off"
[ ! -f "$LEG/MOVED.md" ] && ok "old state not released on a forged receipt" || bad "released on forged receipt"

new_world b2   # truncated after a real migration
mig --apply >/dev/null
head -c 40 "$STATE/migrated-from.json" > "$STATE/t" && mv "$STATE/t" "$STATE/migrated-from.json"
OUT="$(mig --apply)"; rc=$?; echo "  truncated receipt -> exit $rc, status $(echo "$OUT" | statusof)"
[ $rc -eq 3 ] && [ "$(echo "$OUT" | statusof)" = receipt-unverified ] && ok "truncated receipt refused (also by drift: $(mig --drift-check | statusof))" || bad "truncated: $OUT"

new_world b3   # git-tracked
mig --apply >/dev/null
git -C "$PROJ" init -q && git -C "$PROJ" add -f ".core/claude-code/migrated-from.json" 2>/dev/null
OUT="$(mig --apply)"; rc=$?; echo "  git-tracked receipt -> exit $rc, status $(echo "$OUT" | statusof)"
[ $rc -eq 3 ] && [ "$(echo "$OUT" | statusof)" = receipt-unverified ] && ok "tracked receipt refused" || bad "tracked: $OUT"

echo; echo "== (c) forged drift destination =="
new_world c1
mig --apply >/dev/null
OUTSIDE="$SCRATCH/outside.txt"; printf 'untouched\n' > "$OUTSIDE"; osha="$(sha "$OUTSIDE")"
node -e "
const fs=require('fs');const f='$STATE/migrated-from.json';const r=JSON.parse(fs.readFileSync(f,'utf8'));
for(const e of r.files) if(e.from.endsWith('capability-history.jsonl')) e.to='$OUTSIDE';
fs.writeFileSync(f,JSON.stringify(r));"
printf '{"row":1}\n{"row":"old-2"}\n' > "$LEG/capability-history.jsonl"
OUT="$(mig --drift-check)"; rc=$?; echo "  forged destination -> exit $rc, status $(echo "$OUT" | statusof)"
[ "$(echo "$OUT" | statusof)" = receipt-unverified ] && ok "forged destination refused" || bad "drift: $OUT"
[ "$(sha "$OUTSIDE")" = "$osha" ] && ok "outside file byte-identical ($osha)" || bad "outside file modified"

echo; echo "== (d2) old -> new -> old -> new: every appended line arrives exactly once =="
new_world d2
mig --apply >/dev/null
DEST="$(node -e "const r=JSON.parse(require('fs').readFileSync('$STATE/migrated-from.json','utf8'));console.log(r.files.find(f=>f.from.endsWith('capability-history.jsonl')).to)")"
printf '{"row":1}\n{"row":"old-2"}\n' > "$LEG/capability-history.jsonl"
printf '{"row":"new-1"}\n' >> "$DEST"
mig --drift-check >/dev/null; mig --drift-check >/dev/null
printf '{"row":1}\n{"row":"old-2"}\n{"row":"old-3"}\n' > "$LEG/capability-history.jsonl"
printf '{"row":"new-2"}\n' >> "$DEST"
mig --drift-check >/dev/null; OUT="$(mig --drift-check)"
for r in '{"row":1}' '{"row":"old-2"}' '{"row":"old-3"}' '{"row":"new-1"}' '{"row":"new-2"}'; do
  n="$(grep -cF -- "$r" "$DEST")"; [ "$n" = 1 ] && ok "$r appears once" || bad "$r appears $n times"
done
[ "$(echo "$OUT" | statusof)" = unchanged ] && ok "a further drift check is a no-op" || bad "drift not idempotent: $OUT"

echo; echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
