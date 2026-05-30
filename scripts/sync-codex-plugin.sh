#!/usr/bin/env bash
# Sync plugins/core/ from the canonical source directories.
# Run after any change to skills/, hooks/, or tests/ before committing.
# Used by /cut-release as a pre-release step.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Syncing plugins/core/ from source..."
rsync -a --delete --no-l "${REPO_ROOT}/skills/" "${REPO_ROOT}/plugins/core/skills/"
rsync -a --delete --no-l "${REPO_ROOT}/hooks/" "${REPO_ROOT}/plugins/core/hooks/"
rsync -a --delete --no-l "${REPO_ROOT}/tests/" "${REPO_ROOT}/plugins/core/tests/"

# Keep doc files current
for f in ARCHITECTURE.md CHANGELOG.md README.md INSTALL.md LICENSE RELEASE.json .gitignore; do
  cp "${REPO_ROOT}/$f" "${REPO_ROOT}/plugins/core/$f" 2>/dev/null || true
done

# Sync the codex plugin manifest (version must match root)
cp "${REPO_ROOT}/.codex-plugin/plugin.json" "${REPO_ROOT}/plugins/core/.codex-plugin/plugin.json"

echo "Done. plugins/core/ is in sync."
echo "Run: node -e '...' (ci.yml Codex marketplace path integrity step) to verify."
