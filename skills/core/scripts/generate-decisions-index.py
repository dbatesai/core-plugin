#!/usr/bin/env python3
"""Regenerate <project>/_memories/INDEX-decisions.md from dc-*.md units.

Walks `<project>/_memories/dc-*.md` (top-level only — archived units in
`_memories/archive/` stay out of the index), parses YAML frontmatter for
id / status / date, pulls the H1 line from the body as the summary, sorts
by the numeric DC id, and writes the markdown table.

Per DC-77 the script ships with the plugin (not per-project). Run from any
CORE project root, or pass an explicit memories dir:

    python3 ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.py
    python3 ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.py \\
        <project>/_memories/

The header comment in the regenerated file points back here so a future
reader knows where the source of truth lives.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DC_PATTERN = re.compile(r"^dc-(\d+)-.+\.md$")
SUMMARY_MAX = 100  # characters; truncate with ellipsis past this


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Minimal YAML frontmatter parser — scalars only is enough for the index."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 4:].lstrip("\n")
    fm: dict = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith(" ") or line.startswith("\t"):
            continue  # skip nested keys / list items — we only need top-level scalars
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        v = v.strip().strip('"').strip("'")
        if v == "":
            continue
        fm[k.strip()] = v
    return fm, body


def extract_summary(body: str) -> str:
    """Pull a one-line summary from the unit body.

    Preference order:
      1. The first H1 line (e.g. `# DC-77: ...`)
      2. The first non-blank paragraph line
    """
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()
    for line in body.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            return s
    return ""


def best_date(fm: dict) -> str:
    """Pick the most informative date from frontmatter.

    Prefer `updated` (most recent edit), then `created`. Returns the raw
    string; the index keeps dates as authored in the units.
    """
    for key in ("updated", "created", "date"):
        if key in fm and fm[key]:
            return str(fm[key])[:10]  # YYYY-MM-DD
    return "unknown"


def truncate(text: str, max_len: int = SUMMARY_MAX) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "…"


def build_index(memories_dir: Path) -> str:
    rows = []
    for entry in sorted(memories_dir.iterdir()):
        if not entry.is_file():
            continue
        m = DC_PATTERN.match(entry.name)
        if not m:
            continue
        try:
            text = entry.read_text()
        except OSError:
            continue
        fm, body = parse_frontmatter(text)
        rows.append({
            "sort_key": int(m.group(1)),
            "id": fm.get("id", entry.stem),
            "date": best_date(fm),
            "status": fm.get("status", "unknown"),
            "summary": truncate(extract_summary(body)),
        })
    rows.sort(key=lambda r: r["sort_key"])

    lines = [
        "# Decisions Index",
        "",
        "> Auto-generated from `_memories/dc-*.md` frontmatter (flat layout per DC-68).",
        "> Do not edit manually — re-run `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.py`",
        "> to regenerate. Script ships with the plugin per DC-77.",
        "",
        f"**{len(rows)} decisions indexed.**",
        "",
        "| ID | Date | Status | Summary |",
        "|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['id']} | {r['date']} | {r['status']} | {r['summary']} |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        memories_dir = Path(argv[1]).resolve()
    else:
        # Default: look for _memories/ in cwd
        memories_dir = (Path.cwd() / "_memories").resolve()

    if not memories_dir.is_dir():
        print(f"error: {memories_dir} is not a directory", file=sys.stderr)
        return 2

    index_path = memories_dir / "INDEX-decisions.md"
    content = build_index(memories_dir)
    index_path.write_text(content)
    print(f"Wrote {index_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
