#!/usr/bin/env python3
"""PreToolUse hook: remind the agent to declare `intent: skill-edit` when writing
to CORE skill-product surfaces.

Matches three install shapes:
  - Plugin install (Claude Code marketplace or local-path):
        ~/.claude/plugins/cache/<marketplace>/core/<version>/skills/core/**
  - Workshop mirror (new layout): <workshop>/core-skill/skills/core/**
  - Legacy direct install:        ~/.claude/skills/core/**

Reads stdin as JSON per Claude Code's PreToolUse hook contract; outputs an
additionalContext reminder if the write target is in skill-product scope.
Always exits 0 (advisory, not blocking).
"""
import json
import sys


SKILL_PATHS = [
    "/.claude/skills/core/",   # legacy direct install (clone-into-skills)
    "/skills/core/",           # plugin install + workshop mirror new layout
    "/core-skill/",            # workshop mirror catch-all (covers root-level docs)
]


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError, ValueError):
        sys.exit(0)

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not any(p in file_path for p in SKILL_PATHS):
        sys.exit(0)

    context = (
        f"SKILL-PRODUCT WRITE DETECTED: {file_path}\n"
        "Per data-storage protocol (DC-24), skill-product writes require a Pre-Write Declaration:\n"
        "  Writing to: <abs path> — category: skill product — naming: <convention> — rationale: <≤80c>\n"
        "  intent: skill-edit\n"
        "If this write is intentional skill editing, declare PWD with intent: skill-edit and proceed.\n"
        "If this destination is wrong, reconsider — see 7-rule routing sheet in protocols/data-storage.md."
    )

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context
        }
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
