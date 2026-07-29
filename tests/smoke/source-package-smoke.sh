#!/usr/bin/env bash
# source-package-smoke.sh — prove the shipped hooks work from a package built
# out of the SOURCE tree, not from the source tree in place. It builds the
# package the way the marketplace delivers it (git archive of plugins/core —
# committed files ONLY, so an untracked working-tree file can't fake a pass),
# sets CLAUDE_PLUGIN_ROOT to that copy, and smokes all three lifecycle hooks
# against a scratch store.
#
# What it does NOT prove: that either live installed cache carries this build.
# A fresh source package and an installed cache are separate identities; the
# installed one is checked by verify-release-identity.mjs --installed. Touches
# nothing real: no live settings, no real project, no network, no live headless
# close. Re-runnable; prints PASS/FAIL per check.
#
# Lives in tests/smoke/ and never ships — the package hygiene checks below
# assert tests/ stays out of the artifact. Self-locates its repo, prints its own
# sha256 so an evidence receipt can pin the exact procedure that ran, and runs
# in CI (.github/workflows/ci.yml, source-package-smoke job — full-history
# checkout so the rollback leg can build the immediate-prior release tag).
#
# Usage: bash tests/smoke/source-package-smoke.sh [<core-plugin-repo>]
set -u
REPO="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
FIXTURE="$REPO/tests/fixtures/nested-store"
if command -v sha256sum >/dev/null 2>&1; then SELF_SHA="$(sha256sum "$0" | cut -d' ' -f1)"; else SELF_SHA="$(shasum -a 256 "$0" | cut -d' ' -f1)"; fi
echo "procedure sha256: $SELF_SHA"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/core-pkg-smoke-XXXX")"
PKG="$SCRATCH/plugin-root"            # what ${CLAUDE_PLUGIN_ROOT} points at post-install
STORE="$SCRATCH/store"               # scratch memory store (clone of the committed fixture)
HOOKS="$PKG/skills/core/hooks"
pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

echo "== Build the packaged artifact (git archive HEAD:plugins/core — committed files only) =="
mkdir -p "$PKG"
if git -C "$REPO" archive HEAD:plugins/core | tar -x -C "$PKG"; then ok "packaged from committed tree"; else bad "git archive failed"; exit 1; fi
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
echo "  source commit: $COMMIT"

echo "== Package hygiene: only the shipped tree, no dev cruft =="
[ -f "$PKG/hooks/hooks.json" ] && ok "hooks.json present" || bad "hooks.json missing"
[ -f "$PKG/skills/core/SKILL.md" ] && ok "SKILL.md present" || bad "SKILL.md missing"
[ ! -d "$PKG/tests" ] && ok "no tests/ dir ships" || bad "tests/ leaked into package"
find "$PKG" -name '*.test.mjs' | grep -q . && bad "*.test.mjs leaked into package" || ok "no test files ship"

echo "== Clone a scratch memory store (never a real project) =="
cp -r "$FIXTURE" "$STORE" && ok "scratch store ready" || bad "fixture clone failed"

echo "== SessionStart hook (from the packaged path) =="
OUT="$(CLAUDE_PLUGIN_ROOT="$PKG" CORE_HOOKS_LOG_FILE=/dev/null node "$HOOKS/session-start-hook.mjs" 2>/dev/null)"
echo "$OUT" | grep -q '`/core`' && ok "injects the /core directive" || bad "no /core directive (got: $OUT)"

echo "== SessionStart AUTHORITY: hostile HOME cannot redirect the first action =="
EVIL="$SCRATCH/attacker-home"; mkdir -p "$EVIL/.claude"
printf '{"env":{"CORE_AUTOSTART_SKILL":"/evil:entry","CORE_AUTOSTART_ALLOWED_SKILLS":"/evil:entry"}}' > "$EVIL/.claude/settings.json"
OUT="$(CLAUDE_PLUGIN_ROOT="$PKG" CORE_HOOKS_LOG_FILE=/dev/null HOME="$EVIL" USERPROFILE="$EVIL" CORE_AUTOSTART_SKILL='/evil:entry' node "$HOOKS/session-start-hook.mjs" 2>/dev/null)"
if echo "$OUT" | grep -q '`/core`' && ! echo "$OUT" | grep -q '/evil:entry'; then ok "attacker skill rejected, fell back to /core"; else bad "AUTHORITY BYPASS: $OUT"; fi

echo "== UserPromptSubmit hook: retrieval from the packaged path, tier label reaches output =="
OUT="$(printf '{"prompt":"quokka incident","cwd":"%s"}' "$STORE" | CLAUDE_PLUGIN_ROOT="$PKG" CORE_RETRIEVAL_STORE="$STORE" node "$HOOKS/retrieve-context-hook.mjs" 2>/dev/null)"
echo "$OUT" | grep -q 'obs-nested-note' && ok "nested unit retrieved from the packaged artifact" || bad "nested unit not retrieved from the packaged artifact (got: $OUT)"
echo "$OUT" | grep -q 'obs-nested-note \[observation\]' && ok "authority tier reaches the injected context" || bad "tier label stripped (got: $OUT)"

echo "== UserPromptSubmit hook: no store in cwd → no retrieval, no side effect =="
EMPTY="$SCRATCH/empty"; mkdir -p "$EMPTY"
OUT="$(printf '{"prompt":"anything","cwd":"%s"}' "$EMPTY" | CLAUDE_PLUGIN_ROOT="$PKG" CORE_RETRIEVAL_STORE="$EMPTY" node "$HOOKS/retrieve-context-hook.mjs" 2>/dev/null)"
[ -z "$OUT" ] && [ ! -e "$EMPTY/_memories" ] && ok "no store → empty output, no littering" || bad "wrote into a store-less dir or emitted output"

echo "== SessionEnd hook: loads from the packaged path (full import chain) + honors kill switch =="
OUT="$(CLAUDE_PLUGIN_ROOT="$PKG" CORE_HOOKS_LOG_FILE=/dev/null CORE_AUTO_CLOSE=0 node "$HOOKS/close-pass-hook.mjs" 2>&1; echo "rc=$?")"
echo "$OUT" | grep -q 'rc=0' && ok "close hook loads (imports resolve in package) + kill switch exits clean" || bad "close hook failed to load/exit (got: $OUT)"

echo "== Rollback / version round-trip: a store written by THIS version, read by the immediate-prior release, then this version again =="
# The real downgrade risk: this version writes an index with path/tier/content-sig;
# the user rolls back one release; that release must still ANSWER — a named unit,
# not an empty list — without reporting units the store does not hold; then
# re-upgrading must regenerate cleanly (no permanent corruption from a round-trip).
ROLLSTORE="$SCRATCH/rollback-store"; cp -r "$FIXTURE" "$ROLLSTORE"
NEWGEN="$PKG/skills/core/scripts/generate-summary-index.mjs"
node "$NEWGEN" "$ROLLSTORE" >/dev/null 2>&1
NEWFIELDS="$(node -e "const i=require('$ROLLSTORE/_memories/_lib/unit-summaries.json');console.log((i.units[0].path&&i.units[0].tier)?'ok':'missing')" 2>/dev/null)"
[ "$NEWFIELDS" = "ok" ] && ok "this version wrote a path/tier index" || bad "index missing path/tier"

# The immediate-prior release is the greatest release tag below the version being
# packaged — derived, so the leg keeps testing the compatibility step users
# actually take instead of a tag that ages out.
CURVER="$(node -e "process.stdout.write(require('$PKG/.claude-plugin/plugin.json').version)" 2>/dev/null)"
PREVTAG="$( { git -C "$REPO" tag --list 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'; echo "v$CURVER"; } \
  | sort -V -u | awk -v cur="v$CURVER" '$0==cur{print prev; exit} {prev=$0}' )"
if [ -z "$PREVTAG" ]; then
  bad "no release tag below v$CURVER — the rollback leg has nothing to downgrade to"
else
  echo "  packaging v$CURVER; immediate-prior release: $PREVTAG"
  PREVPKG="$SCRATCH/prev-plugin-root"; mkdir -p "$PREVPKG"
  git -C "$REPO" archive "$PREVTAG:plugins/core" | tar -x -C "$PREVPKG"

  # A named, non-empty answer. `rc-ok:[]` fails this check: a release that
  # retrieves nothing has not demonstrated compatibility, only survival.
  OUT="$(node -e "import('$PREVPKG/skills/core/scripts/retrieve-context.mjs').then(m=>{const r=m.retrieveContext('alpha subsystem rollout','$ROLLSTORE');console.log('rc-ok:'+JSON.stringify(r.map(x=>x.id)))}).catch(e=>console.log('CRASH:'+e.message))" 2>&1)"
  case "$OUT" in
    rc-ok:*) ok "$PREVTAG retriever reads the store this version wrote without crashing" ;;
    *)       bad "$PREVTAG retriever crashed on the new store: $OUT" ;;
  esac
  echo "$OUT" | grep -q '"dc-strong"' \
    && ok "$PREVTAG still returns the named unit the query asks for ($OUT)" \
    || bad "$PREVTAG returned no named result — an empty answer is not compatibility ($OUT)"

  # Every id it reports must correspond to a unit the store actually holds.
  PHANTOM=""
  for id in $(printf '%s' "$OUT" | sed 's/^rc-ok://' | tr -d '[]"' | tr ',' ' '); do
    find "$ROLLSTORE/_memories" -name "$id.md" | grep -q . || PHANTOM="$PHANTOM $id"
  done
  [ -z "$PHANTOM" ] && ok "no phantom units on downgrade" || bad "$PREVTAG reported units the store does not hold:$PHANTOM"

  # Re-upgrade: this version reads the round-tripped store and finds a unit only
  # it can reach, proving the downgrade left nothing permanently broken.
  OUT="$(node -e "import('$NEWGEN').then(async m=>{const {retrieveContext}=await import('$PKG/skills/core/scripts/retrieve-context.mjs');const r=retrieveContext('quokka incident','$ROLLSTORE');console.log('up:'+JSON.stringify(r.map(x=>x.id)))})" 2>&1)"
  echo "$OUT" | grep -q 'obs-nested-note' && ok "re-upgrade regenerates cleanly, nested unit findable again (no round-trip corruption)" || bad "re-upgrade did not recover: $OUT"
fi

echo
echo "== source-package smoke @ $COMMIT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
