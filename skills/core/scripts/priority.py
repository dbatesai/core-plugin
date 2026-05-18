#!/usr/bin/env python3
"""Priority function for CORE memory units, per DC-69.

priority(unit, t) = w_R · R(unit, t)
                  + w_F · F(unit, t)
                  + w_S · S(unit)
                  + w_A · A(unit, t)
                  + P(unit)

R = exp(-recency_days / τ), τ=60 days.
F = distinct surface-types the unit appears in, normalized by 6.
S = source-type weight (PROJECT.md=1.0, configuration=0.9, operational=0.7,
    handoff/output=0.5, session_log=0.3, transcript=0.2).
A = Jaccard overlap of unit topics with session-intent topics.
P = pin contribution (floor 0.7 / floor 0.9 / override 1.5 / multiply 0.3).

Per DC-77 the script lives in the plugin, not per-project. Import paths or
shell invocation from any project's _memories/ directory.

Library usage:
    from priority import score, score_unit_file, score_proxy_RS
    s = score_unit_file('_memories/dc-67-no-mcp.md',
                        session_topics=['memory-architecture'])

CLI diagnostic — rank a project's units by priority:
    python3 priority.py <project>/_memories/ [--top N] [--intent t1,t2,...]
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

# ---------- DC-69 constants ----------

W_R = 0.30  # recency weight
W_F = 0.15  # frequency weight
W_S = 0.20  # source-type weight
W_A = 0.35  # alignment weight
TAU_DAYS = 60.0  # exponential decay τ
SCORE_PRUNE_THRESHOLD = 0.3  # Tier 2 walk pruning threshold (R·S proxy)

SOURCE_TYPE_WEIGHTS = {
    "PROJECT.md": 1.0,
    "configuration": 0.9,
    "operational": 0.7,
    "handoff": 0.5,
    "output": 0.5,
    "session_log": 0.3,
    "transcript": 0.2,
}

PIN_CONTRIBUTION = {
    "floor": ("floor", 0.7),
    "true": ("floor", 0.9),
    "always": ("override", 1.5),
    "false": ("multiply", 0.3),
}


# ---------- Frontmatter parsing (constrained subset of YAML) ----------

@dataclass
class Unit:
    path: Path
    fm: dict
    body: str

    @property
    def id(self) -> str:
        return self.fm.get("id", self.path.stem)


def _coerce(value: str):
    v = value.strip().strip('"').strip("'")
    if v.lower() in {"true", "false"}:
        return v.lower() == "true"
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end == -1:
        return {}, text
    raw_fm = text[4:end]
    body = text[end + 4:].lstrip("\n")
    fm: dict = {}
    current_key = None
    current_list: list | None = None
    current_dict: dict | None = None
    for line in raw_fm.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if indent == 0:
            current_dict = None
            if ":" not in stripped:
                continue
            k, _, v = stripped.partition(":")
            k = k.strip()
            v = v.strip()
            if v == "":
                current_key = k
                current_list = []
                fm[k] = current_list
            else:
                fm[k] = _coerce(v)
                current_key = None
                current_list = None
        elif stripped.startswith("- "):
            item = stripped[2:].strip()
            if ":" in item and not item.startswith("http"):
                key, _, val = item.partition(":")
                current_dict = {key.strip(): _coerce(val)}
                if current_list is not None:
                    current_list.append(current_dict)
            else:
                if current_list is not None:
                    current_list.append(_coerce(item))
                current_dict = None
        elif current_dict is not None and ":" in stripped:
            key, _, val = stripped.partition(":")
            current_dict[key.strip()] = _coerce(val)
    return fm, body


def load_unit(path: str | Path) -> Unit:
    p = Path(path)
    text = p.read_text()
    fm, body = parse_frontmatter(text)
    return Unit(path=p, fm=fm, body=body)


# ---------- Signal computations ----------

def parse_iso_date(s) -> date | None:
    if not s:
        return None
    if isinstance(s, date):
        return s
    s = str(s).strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        return None
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def recency_days(unit: Unit, today: date) -> float:
    candidates = [
        parse_iso_date(unit.fm.get("last_accessed")),
        parse_iso_date(unit.fm.get("updated")),
        parse_iso_date(unit.fm.get("created")),
    ]
    candidates = [c for c in candidates if c is not None]
    if not candidates:
        return 365.0
    freshest = max(candidates)
    return max(0.0, (today - freshest).days)


def signal_R(unit: Unit, today: date) -> float:
    days = recency_days(unit, today)
    return math.exp(-days / TAU_DAYS)


def signal_F(unit: Unit) -> float:
    sources = unit.fm.get("sources") or []
    if not isinstance(sources, list):
        return 0.0
    surfaces_seen: set[str] = set()
    for src in sources:
        if not isinstance(src, str):
            continue
        s = src.lower()
        if "project.md" in s:
            surfaces_seen.add("PROJECT.md")
        elif "dm-profile" in s:
            surfaces_seen.add("dm-profile")
        elif "handoff" in s:
            surfaces_seen.add("handoffs")
        elif "session" in s:
            surfaces_seen.add("sessions")
        elif "output" in s or s.startswith("outputs/"):
            surfaces_seen.add("outputs")
        elif "inbox" in s:
            surfaces_seen.add("inbox")
    return len(surfaces_seen) / 6.0


def signal_S(unit: Unit) -> float:
    sources = unit.fm.get("sources") or []
    if not isinstance(sources, list):
        return 0.5
    best = 0.0
    for src in sources:
        if not isinstance(src, str):
            continue
        s = src.lower()
        if "project.md" in s:
            best = max(best, SOURCE_TYPE_WEIGHTS["PROJECT.md"])
        elif "dm-profile" in s or "settings" in s or "config" in s:
            best = max(best, SOURCE_TYPE_WEIGHTS["configuration"])
        elif "swarm-effectiveness" in s or "dream-cycle" in s:
            best = max(best, SOURCE_TYPE_WEIGHTS["operational"])
        elif "handoff" in s or "output" in s or s.startswith("outputs/"):
            best = max(best, SOURCE_TYPE_WEIGHTS["handoff"])
        elif "session" in s:
            best = max(best, SOURCE_TYPE_WEIGHTS["session_log"])
    return best if best > 0 else 0.5


def signal_A(unit: Unit, session_topics: Iterable[str]) -> float:
    unit_topics = set(unit.fm.get("topics") or [])
    session = set(session_topics)
    if not unit_topics or not session:
        return 0.0
    return len(unit_topics & session) / len(unit_topics | session)


def pin_contribution(unit: Unit) -> tuple[str, float]:
    pin = unit.fm.get("pinned")
    if pin is None or pin is False:
        return ("none", 0.0)
    key = str(pin).lower()
    return PIN_CONTRIBUTION.get(key, ("none", 0.0))


# ---------- Main scoring function ----------

def score(unit: Unit, session_topics: Iterable[str] | None = None,
          today: date | None = None) -> float:
    if today is None:
        today = date.today()
    if session_topics is None:
        session_topics = []

    R = signal_R(unit, today)
    F = signal_F(unit)
    S = signal_S(unit)
    A = signal_A(unit, session_topics)
    pin_mode, pin_val = pin_contribution(unit)

    base = W_R * R + W_F * F + W_S * S + W_A * A

    if pin_mode == "override":
        return pin_val
    elif pin_mode == "floor":
        return max(base, pin_val)
    elif pin_mode == "multiply":
        return base * pin_val
    return base


def score_unit_file(path: str | Path, session_topics: Iterable[str] | None = None,
                    today: date | None = None) -> float:
    return score(load_unit(path), session_topics, today)


def score_proxy_RS(unit: Unit, today: date | None = None) -> float:
    """Fast proxy for Tier 2 walk pruning — R · S without alignment."""
    if today is None:
        today = date.today()
    return signal_R(unit, today) * signal_S(unit)


# ---------- CLI diagnostic ----------

def _iter_units(memories_dir: Path):
    for fname in sorted(os.listdir(memories_dir)):
        if not fname.endswith(".md"):
            continue
        if fname.startswith("_") or fname.startswith("INDEX") or fname == "README.md":
            continue
        yield load_unit(memories_dir / fname)


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Rank a project's CORE memory units by priority.")
    parser.add_argument("memories_dir", nargs="?", default="_memories",
                        help="Path to <project>/_memories/ (default: ./_memories)")
    parser.add_argument("--top", type=int, default=10,
                        help="Number of top-ranked units to display (default: 10)")
    parser.add_argument("--intent", default="",
                        help="Comma-separated session intent topics for alignment signal")
    parser.add_argument("--today", default=None,
                        help="Override today's date as YYYY-MM-DD (for reproducible scoring)")
    args = parser.parse_args(argv)

    memories_dir = Path(args.memories_dir).resolve()
    if not memories_dir.is_dir():
        print(f"error: {memories_dir} is not a directory", file=sys.stderr)
        return 2

    intent = [t.strip() for t in args.intent.split(",") if t.strip()]
    today = parse_iso_date(args.today) if args.today else date.today()

    ranked = []
    for u in _iter_units(memories_dir):
        ranked.append((score(u, intent, today), u))
    ranked.sort(key=lambda t: t[0], reverse=True)

    print(f"Ranking {len(ranked)} units in {memories_dir}")
    print(f"Date: {today.isoformat()}, intent topics: {intent or '(none)'}")
    print("-" * 64)
    for s, u in ranked[: args.top]:
        topics = u.fm.get("topics") or []
        print(f"  {s:.3f}  {u.id:42s}  topics={topics}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
