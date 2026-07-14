#!/usr/bin/env bash
# packaged-install-smoke.sh — prove the shipped hooks work from the INSTALLED
# artifact, not the source tree (Gate 0: installed ≠ source). Builds the package
# the way the marketplace delivers it (git archive of plugins/core — committed
# files ONLY, so an untracked working-tree file can't fake a pass), sets
# CLAUDE_PLUGIN_ROOT to that copy, and smokes all three lifecycle hooks against a
# scratch store. Touches nothing real: no live settings, no real project, no
# network, no live headless close. Re-runnable; prints PASS/FAIL per check.
#
# COMMITTED procedure (Train A A7, Crest closure program): lives in tests/smoke/
# (never ships — package hygiene below asserts tests/ stays out of the artifact),
# self-locates its repo, prints its own sha256 so the evidence receipt can pin
# the exact procedure that ran, and runs in CI (.github/workflows/ci.yml,
# packaged-install-smoke job — full-history checkout so the rollback leg can
# build the previous release tag).
#
# Usage: bash tests/smoke/packaged-install-smoke.sh [<core-plugin-repo>]
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

echo "== SessionStart hook (from installed path) =="
OUT="$(CLAUDE_PLUGIN_ROOT="$PKG" CORE_HOOKS_LOG_FILE=/dev/null node "$HOOKS/session-start-hook.mjs" 2>/dev/null)"
echo "$OUT" | grep -q '`/core`' && ok "injects the /core directive" || bad "no /core directive (got: $OUT)"

echo "== SessionStart AUTHORITY (Hale §5): hostile HOME cannot redirect the first action =="
EVIL="$SCRATCH/attacker-home"; mkdir -p "$EVIL/.claude"
printf '{"env":{"CORE_AUTOSTART_SKILL":"/evil:entry","CORE_AUTOSTART_ALLOWED_SKILLS":"/evil:entry"}}' > "$EVIL/.claude/settings.json"
OUT="$(CLAUDE_PLUGIN_ROOT="$PKG" CORE_HOOKS_LOG_FILE=/dev/null HOME="$EVIL" USERPROFILE="$EVIL" CORE_AUTOSTART_SKILL='/evil:entry' node "$HOOKS/session-start-hook.mjs" 2>/dev/null)"
if echo "$OUT" | grep -q '`/core`' && ! echo "$OUT" | grep -q '/evil:entry'; then ok "attacker skill rejected, fell back to /core"; else bad "AUTHORITY BYPASS: $OUT"; fi

echo "== UserPromptSubmit hook: retrieval from installed path, tier label reaches output =="
OUT="$(printf '{"prompt":"quokka incident","cwd":"%s"}' "$STORE" | CLAUDE_PLUGIN_ROOT="$PKG" CORE_RETRIEVAL_STORE="$STORE" node "$HOOKS/retrieve-context-hook.mjs" 2>/dev/null)"
echo "$OUT" | grep -q 'obs-nested-note' && ok "nested unit retrieved from installed artifact" || bad "nested unit not retrieved (got: $OUT)"
echo "$OUT" | grep -q 'obs-nested-note \[observation\]' && ok "authority tier reaches the injected context" || bad "tier label stripped (got: $OUT)"

echo "== UserPromptSubmit hook: no store in cwd → no retrieval, no side effect =="
EMPTY="$SCRATCH/empty"; mkdir -p "$EMPTY"
OUT="$(printf '{"prompt":"anything","cwd":"%s"}' "$EMPTY" | CLAUDE_PLUGIN_ROOT="$PKG" CORE_RETRIEVAL_STORE="$EMPTY" node "$HOOKS/retrieve-context-hook.mjs" 2>/dev/null)"
[ -z "$OUT" ] && [ ! -e "$EMPTY/_memories" ] && ok "no store → empty output, no littering" || bad "wrote into a store-less dir or emitted output"

echo "== SessionEnd hook: loads from installed path (full import chain) + honors kill switch =="
OUT="$(CLAUDE_PLUGIN_ROOT="$PKG" CORE_HOOKS_LOG_FILE=/dev/null CORE_AUTO_CLOSE=0 node "$HOOKS/close-pass-hook.mjs" 2>&1; echo "rc=$?")"
echo "$OUT" | grep -q 'rc=0' && ok "close hook loads (imports resolve in package) + kill switch exits clean" || bad "close hook failed to load/exit (got: $OUT)"

echo "== Rollback / version round-trip: a store written by the NEW version, read by the OLD release, then the NEW version again =="
# The real downgrade risk: vN writes an index with path/tier/content-sig; the user
# rolls back to vN-1; vN-1 must not crash or resurrect; then re-upgrading must
# regenerate cleanly (no permanent corruption from a version round-trip).
ROLLSTORE="$SCRATCH/rollback-store"; cp -r "$FIXTURE" "$ROLLSTORE"
NEWGEN="$PKG/skills/core/scripts/generate-summary-index.mjs"
node "$NEWGEN" "$ROLLSTORE" >/dev/null 2>&1
NEWFIELDS="$(node -e "const i=require('$ROLLSTORE/_memories/_lib/unit-summaries.json');console.log((i.units[0].path&&i.units[0].tier)?'ok':'missing')" 2>/dev/null)"
[ "$NEWFIELDS" = "ok" ] && ok "new version wrote a path/tier index" || bad "new index missing path/tier"
# Build the previous release (v3.10.0) the same way and read the new store with it.
PREVTAG="$(git -C "$REPO" tag | grep -E '^v3\.10\.0$' | head -1)"
if [ -n "$PREVTAG" ]; then
  PREVPKG="$SCRATCH/prev-plugin-root"; mkdir -p "$PREVPKG"
  git -C "$REPO" archive "$PREVTAG:plugins/core" | tar -x -C "$PREVPKG"
  OUT="$(node -e "import('$PREVPKG/skills/core/scripts/retrieve-context.mjs').then(m=>{const r=m.retrieveContext('quokka incident','$ROLLSTORE');console.log('rc-ok:'+JSON.stringify(r.map(x=>x.id)))}).catch(e=>console.log('CRASH:'+e.message))" 2>&1)"
  echo "$OUT" | grep -q 'rc-ok:' && ok "$PREVTAG retriever reads the new-version store without crashing ($OUT)" || bad "old retriever crashed on new store: $OUT"
  echo "$OUT" | grep -q 'obs-nested-note' && bad "old retriever resurrected a nested unit it should not reach" || ok "no resurrection on downgrade"
  # Re-upgrade: new version reads the (now old-format-rewritten) store and regenerates.
  OUT="$(node -e "import('$NEWGEN').then(async m=>{const {retrieveContext}=await import('$PKG/skills/core/scripts/retrieve-context.mjs');const r=retrieveContext('quokka incident','$ROLLSTORE');console.log('up:'+JSON.stringify(r.map(x=>x.id)))})" 2>&1)"
  echo "$OUT" | grep -q 'obs-nested-note' && ok "re-upgrade regenerates cleanly, nested unit findable again (no round-trip corruption)" || bad "re-upgrade did not recover: $OUT"
else
  echo "  SKIP  v3.10.0 tag not found — rollback round-trip not run"
fi

echo
echo "== packaged-install smoke @ $COMMIT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
