#!/usr/bin/env python3
"""Tier 2 edge-graph walk for CORE memory retrieval, per DC-68/retrieval.md.

Given a seed unit, walks typed edges up to a hop cap, applying the R·S proxy
from priority.py for branch pruning. Deterministic alternative to LLM-by-hand
edge traversal — per DC-77, graph traversal logic ships in the plugin.

Library usage:
    from graph_walk import walk
    candidates = walk('_memories/dc-67-no-mcp.md',
                      memories_dir='_memories',
                      hops=2,
                      session_topics=['memory-architecture'])

CLI:
    python3 graph-walk.py <seed-unit-path> [--memories <dir>] [--hops 2]
                          [--budget 15] [--intent t1,t2] [--prune 0.3]
                          [--format json|text]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Iterator

# Import scoring from the co-located priority.py
_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))
from priority import (  # noqa: E402
    Unit, load_unit, score_proxy_RS, extract_edges, parse_iso_date,
    SCORE_PRUNE_THRESHOLD,
)


@dataclass
class WalkCandidate:
    unit_id: str
    path: Path
    hop: int
    rs_score: float
    via_edge_type: str
    via_source: str


def _resolve_target(target: str, memories_dir: Path) -> Path | None:
    """Resolve an edge target string to an absolute unit file path."""
    t = target.strip()
    # Try as a direct path first
    direct = Path(t)
    if direct.is_absolute() and direct.exists():
        return direct
    # Strip .md suffix for matching
    stem = t.removesuffix(".md")
    # Try memories_dir / <stem>.md
    candidate = memories_dir / f"{stem}.md"
    if candidate.exists():
        return candidate
    # Try memories_dir / <target> as-is
    candidate2 = memories_dir / t
    if candidate2.exists():
        return candidate2
    return None


def walk(seed_path: str | Path,
         memories_dir: str | Path = "_memories",
         hops: int = 2,
         budget: int = 15,
         session_topics: list[str] | None = None,
         prune_threshold: float = SCORE_PRUNE_THRESHOLD,
         today: date | None = None) -> list[WalkCandidate]:
    """Walk typed edges from seed_path up to `hops` hops.

    Returns candidates ordered by (hop asc, rs_score desc), excluding the seed.
    Branches are pruned when R·S proxy < prune_threshold (default 0.3 per DC-69).
    """
    if today is None:
        today = date.today()
    if session_topics is None:
        session_topics = []

    memories_dir = Path(memories_dir).resolve()
    seed = load_unit(seed_path)

    visited: set[Path] = {Path(seed.path).resolve()}
    queue: list[tuple[int, Path, str, str]] = []  # (hop, path, edge_type, source_id)

    for e in extract_edges(seed):
        target_path = _resolve_target(e["target"], memories_dir)
        if target_path and target_path.resolve() not in visited:
            queue.append((1, target_path, e["type"], seed.id))

    results: list[WalkCandidate] = []

    while queue and len(results) < budget:
        hop, path, edge_type, source_id = queue.pop(0)
        resolved = path.resolve()
        if resolved in visited:
            continue
        visited.add(resolved)

        try:
            unit = load_unit(path)
        except Exception:
            continue

        rs = score_proxy_RS(unit, today)
        if rs < prune_threshold:
            continue  # branch pruned

        results.append(WalkCandidate(
            unit_id=unit.id,
            path=path,
            hop=hop,
            rs_score=rs,
            via_edge_type=edge_type,
            via_source=source_id,
        ))

        if hop < hops:
            for e in extract_edges(unit):
                target_path = _resolve_target(e["target"], memories_dir)
                if target_path and target_path.resolve() not in visited:
                    queue.append((hop + 1, target_path, e["type"], unit.id))

    results.sort(key=lambda c: (c.hop, -c.rs_score))
    return results


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Walk CORE memory unit edges for Tier 2 retrieval.")
    parser.add_argument("seed", help="Path to the seed unit file")
    parser.add_argument("--memories", default=None,
                        help="Path to _memories/ dir (default: sibling to seed)")
    parser.add_argument("--hops", type=int, default=2,
                        help="Maximum hops (default: 2; max recommended: 3)")
    parser.add_argument("--budget", type=int, default=15,
                        help="Maximum candidates in result set (default: 15)")
    parser.add_argument("--intent", default="",
                        help="Comma-separated session intent topics (unused in walk "
                             "but passed through for future alignment integration)")
    parser.add_argument("--prune", type=float, default=SCORE_PRUNE_THRESHOLD,
                        help=f"R·S pruning threshold (default: {SCORE_PRUNE_THRESHOLD})")
    parser.add_argument("--today", default=None,
                        help="Override today's date as YYYY-MM-DD")
    parser.add_argument("--format", choices=["json", "text"], default="json",
                        help="Output format (default: json)")
    args = parser.parse_args(argv)

    seed_path = Path(args.seed).resolve()
    if not seed_path.exists():
        print(f"error: seed unit not found: {seed_path}", file=sys.stderr)
        return 2

    if args.memories:
        memories_dir = Path(args.memories).resolve()
    else:
        memories_dir = seed_path.parent.resolve()

    if not memories_dir.is_dir():
        print(f"error: memories dir not found: {memories_dir}", file=sys.stderr)
        return 2

    today = parse_iso_date(args.today) if args.today else date.today()
    intent = [t.strip() for t in args.intent.split(",") if t.strip()]

    candidates = walk(
        seed_path,
        memories_dir=memories_dir,
        hops=args.hops,
        budget=args.budget,
        session_topics=intent,
        prune_threshold=args.prune,
        today=today,
    )

    if args.format == "json":
        out = [
            {
                "unit_id": c.unit_id,
                "path": str(c.path),
                "hop": c.hop,
                "rs_score": round(c.rs_score, 4),
                "via_edge_type": c.via_edge_type,
                "via_source": c.via_source,
            }
            for c in candidates
        ]
        print(json.dumps(out, indent=2))
    else:
        print(f"Walk from: {seed_path.name}  hops={args.hops}  prune={args.prune}")
        print(f"Date: {today}  memories: {memories_dir}")
        print("-" * 72)
        for c in candidates:
            print(f"  hop={c.hop}  rs={c.rs_score:.3f}  [{c.via_edge_type}]"
                  f"  {c.unit_id}  (via {c.via_source})")
        print(f"\n{len(candidates)} candidates (budget={args.budget})")

    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
