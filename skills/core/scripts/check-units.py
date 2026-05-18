#!/usr/bin/env python3
"""Unit store integrity checker for CORE memory architecture, per DC-77.

Runs structural validation that inference misses silently as the unit store grows.
Two modes (combined by default):

  schema  — required frontmatter fields, valid status/type values, edge target existence
  integrity — orphan detection, dangling edges, stale flagging, INDEX-decisions drift

CLI:
    python3 check-units.py <project-path>
    python3 check-units.py <project-path> --mode schema
    python3 check-units.py <project-path> --mode integrity
    python3 check-units.py <project-path> --json

Exit codes: 0 = all pass, 1 = warnings, 2 = failures, 3 = setup error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))
from priority import (  # noqa: E402
    Unit, load_unit, extract_edges, score_proxy_RS, parse_iso_date,
)

# ---------- Schema constants ----------

REQUIRED_FIELDS = {"id", "type", "status", "created", "updated", "topics"}

VALID_STATUSES = {"active", "retired", "archived"}

VALID_TYPES = {
    "decision", "risk", "person", "deliverable", "principle",
    "explainer", "review-finding", "observation", "topic", "reference",
    "feedback", "memory",  # memory is legacy/auto-memory type
}

VALID_EDGE_TYPES = {
    "cites", "supersedes", "depends-on", "conflicts-with",
    "references-person", "references-topic",
    # common inverse/extended forms that appear in the wild
    "depended-on-by", "supersedes-claim",
}

ARCHIVE_RS_THRESHOLD = 0.05   # R·S below this → stale / archive candidate
STALE_DAYS = 90               # last_accessed older than this → stale candidate


# ---------- Result types ----------

@dataclass
class Finding:
    level: str        # PASS | WARN | FAIL
    check: str        # short check name
    unit_id: str      # unit ID or "" for cross-unit checks
    detail: str       # human-readable explanation


@dataclass
class Report:
    memories_dir: Path
    mode: str
    today: date
    findings: list[Finding] = field(default_factory=list)

    def add(self, level: str, check: str, unit_id: str, detail: str) -> None:
        self.findings.append(Finding(level, check, unit_id, detail))

    def counts(self) -> dict[str, int]:
        c: dict[str, int] = {"PASS": 0, "WARN": 0, "FAIL": 0}
        for f in self.findings:
            c[f.level] = c.get(f.level, 0) + 1
        return c

    def exit_code(self) -> int:
        c = self.counts()
        if c.get("FAIL", 0):
            return 2
        if c.get("WARN", 0):
            return 1
        return 0


# ---------- Unit iteration ----------

def _iter_active_units(memories_dir: Path) -> list[Unit]:
    """Load all non-archived, non-cold-stored unit files."""
    units = []
    skip_dirs = {"archive", "cold-storage", "_validation"}
    for entry in sorted(memories_dir.iterdir()):
        if entry.is_dir() and entry.name not in skip_dirs:
            # Sub-dirs that aren't special (shouldn't exist in flat layout, but be safe)
            continue
        if not entry.is_file() or not entry.name.endswith(".md"):
            continue
        name = entry.name
        if name.startswith("_") or name.startswith("INDEX") or name == "README.md":
            continue
        try:
            units.append(load_unit(entry))
        except Exception as e:
            units.append(Unit(path=entry, fm={}, body=f"LOAD ERROR: {e}"))
    return units


def _iter_all_unit_files(memories_dir: Path) -> list[Path]:
    """All .md files that aren't index/readme, including archive subdir."""
    paths = []
    for root, dirs, files in os.walk(memories_dir):
        dirs[:] = [d for d in dirs if d != "_validation"]
        for fname in files:
            if not fname.endswith(".md"):
                continue
            if fname.startswith("_") or fname.startswith("INDEX") or fname == "README.md":
                continue
            paths.append(Path(root) / fname)
    return paths


# ---------- Schema checks ----------

def check_schema(units: list[Unit], memories_dir: Path, report: Report) -> None:
    all_stems: set[str] = {u.path.stem for u in units}
    # Also include archive stems
    all_files: set[str] = {p.stem for p in _iter_all_unit_files(memories_dir)}

    for u in units:
        uid = u.fm.get("id", u.path.stem)
        load_err = u.body.startswith("LOAD ERROR:") if u.body else False

        if load_err:
            report.add("FAIL", "load", uid, f"Failed to load: {u.body}")
            continue

        # Required fields
        for fld in REQUIRED_FIELDS:
            if fld not in u.fm:
                report.add("FAIL", "required-field", uid,
                           f"Missing required frontmatter field: '{fld}'")

        # Status value
        status = str(u.fm.get("status", "")).lower()
        if status and status not in VALID_STATUSES:
            report.add("WARN", "status-value", uid,
                       f"Unknown status '{status}' (expected: {sorted(VALID_STATUSES)})")

        # Type value
        typ = str(u.fm.get("type", "")).lower()
        if typ and typ not in VALID_TYPES:
            report.add("WARN", "type-value", uid,
                       f"Unknown type '{typ}' (expected one of {sorted(VALID_TYPES)})")

        # topics must be a list
        topics = u.fm.get("topics")
        if topics is not None and not isinstance(topics, list):
            report.add("WARN", "topics-format", uid,
                       "Field 'topics' should be a list, found scalar")

        # Edge validation
        edges_raw = u.fm.get("edges") or []
        for i, item in enumerate(edges_raw if isinstance(edges_raw, list) else []):
            if not isinstance(item, dict):
                report.add("WARN", "edge-format", uid,
                           f"Edge [{i}] is not a mapping: {item!r}")
                continue
            e_type = item.get("type", "")
            e_target = item.get("target", "")
            if not e_type:
                report.add("WARN", "edge-missing-type", uid,
                           f"Edge [{i}] missing 'type' field")
            elif str(e_type) not in VALID_EDGE_TYPES:
                report.add("WARN", "edge-unknown-type", uid,
                           f"Edge [{i}] type '{e_type}' not in committed types "
                           f"{sorted(VALID_EDGE_TYPES)}")
            if not e_target:
                report.add("FAIL", "edge-missing-target", uid,
                           f"Edge [{i}] (type={e_type!r}) missing 'target' field")
            else:
                stem = str(e_target).removesuffix(".md")
                if stem not in all_files and str(e_target) not in all_files:
                    report.add("WARN", "edge-target-missing", uid,
                               f"Edge target '{e_target}' not found in unit store")

        # ID matches filename stem
        declared_id = u.fm.get("id", "")
        if declared_id and declared_id != u.path.stem:
            report.add("WARN", "id-mismatch", uid,
                       f"Declared id '{declared_id}' doesn't match filename stem '{u.path.stem}'")

        report.add("PASS", "schema", uid, "")


# ---------- Integrity checks ----------

def check_integrity(units: list[Unit], memories_dir: Path,
                    report: Report) -> None:
    today = report.today
    unit_by_stem: dict[str, Unit] = {u.path.stem: u for u in units}

    # Build backlink index: stem → set of unit IDs that cite it
    backlinks: dict[str, set[str]] = {u.path.stem: set() for u in units}
    for u in units:
        for e in extract_edges(u):
            target_stem = str(e["target"]).removesuffix(".md")
            if target_stem in backlinks:
                backlinks[target_stem].add(u.path.stem)

    for u in units:
        uid = u.path.stem
        edges = extract_edges(u)
        has_out_edges = len(edges) > 0
        has_in_edges = len(backlinks.get(uid, set())) > 0

        # Orphan detection: no edges in or out
        if not has_out_edges and not has_in_edges:
            report.add("WARN", "orphan", uid,
                       "Unit has no edges (no outgoing, no backlinks) — "
                       "consider adding a 'cites' edge or check if it should be retired")

        # Dangling edges — WARN (not FAIL) because edges can point to external
        # files, outputs, auto-memory, or skill paths that are real but not units
        for e in edges:
            target = str(e["target"])
            # Skip obvious external references (URLs, file paths outside _memories)
            if "://" in target or target.startswith("http"):
                continue
            target_stem = target.removesuffix(".md")
            all_files = {p.stem for p in _iter_all_unit_files(memories_dir)}
            if target_stem not in all_files and target not in all_files:
                report.add("WARN", "dangling-edge", uid,
                           f"Edge target '{target}' (type={e['type']!r}) "
                           f"not found in unit store — external ref or missing unit?")

        # Stale / archive candidate
        rs = score_proxy_RS(u, today)
        if rs < ARCHIVE_RS_THRESHOLD:
            status = str(u.fm.get("status", "active")).lower()
            if status == "active":
                report.add("WARN", "stale", uid,
                           f"R·S={rs:.3f} < {ARCHIVE_RS_THRESHOLD} — "
                           f"archive candidate per DC-69 (last_accessed: "
                           f"{u.fm.get('last_accessed', 'unknown')})")

        # Retired unit still in active dir
        status = str(u.fm.get("status", "")).lower()
        if status == "archived" and "archive" not in str(u.path):
            report.add("WARN", "archived-in-active", uid,
                       "Unit has status=archived but is not in archive/ subdir")

    # INDEX-decisions drift
    index_path = memories_dir / "INDEX-decisions.md"
    if index_path.exists():
        index_text = index_path.read_text()
        dc_stems = {u.path.stem for u in units if u.path.stem.startswith("dc-")}
        missing_from_index: list[str] = []
        for stem in sorted(dc_stems):
            if stem not in index_text:
                missing_from_index.append(stem)
        if missing_from_index:
            report.add("WARN", "index-drift", "",
                       f"INDEX-decisions.md missing {len(missing_from_index)} dc-* units: "
                       f"{', '.join(missing_from_index[:5])}"
                       + (" ..." if len(missing_from_index) > 5 else ""))
        else:
            report.add("PASS", "index-drift", "", "INDEX-decisions.md in sync with dc-* units")
    else:
        report.add("WARN", "index-missing", "",
                   "INDEX-decisions.md not found — run generate-decisions-index.py")

    # Cold-store eligibility
    archive_dir = memories_dir / "archive"
    if archive_dir.is_dir():
        for p in archive_dir.iterdir():
            if not p.is_file() or not p.name.endswith(".md"):
                continue
            if p.name.startswith("_") or p.name.startswith("INDEX"):
                continue
            try:
                u = load_unit(p)
            except Exception:
                continue
            status = str(u.fm.get("status", "")).lower()
            last_acc = parse_iso_date(u.fm.get("last_accessed") or u.fm.get("updated", ""))
            if last_acc is not None:
                age = (today - last_acc).days
                if status == "retired" and age > 365:
                    report.add("WARN", "cold-store-eligible", u.path.stem,
                               f"Archived+retired, last_accessed {age}d ago — "
                               f"cold-store candidate per hygiene.md")


# ---------- Output ----------

def _print_report(report: Report) -> None:
    c = report.counts()
    print(f"\nUnit store: {report.memories_dir}")
    print(f"Mode: {report.mode}  |  Date: {report.today}  |  "
          f"PASS: {c['PASS']}  WARN: {c['WARN']}  FAIL: {c['FAIL']}\n")

    for level in ("FAIL", "WARN"):
        findings = [f for f in report.findings if f.level == level]
        if not findings:
            continue
        print(f"── {level}S ──")
        for f in findings:
            uid_tag = f"[{f.unit_id}]  " if f.unit_id else ""
            print(f"  {f.check}: {uid_tag}{f.detail}")
        print()

    passes = [f for f in report.findings if f.level == "PASS" and f.detail]
    if passes:
        print(f"── PASS ({len(passes)}) ──")
        for f in passes:
            uid_tag = f"[{f.unit_id}]  " if f.unit_id else ""
            print(f"  {f.check}: {uid_tag}{f.detail}")


def _json_report(report: Report) -> None:
    c = report.counts()
    out = {
        "memories_dir": str(report.memories_dir),
        "mode": report.mode,
        "date": report.today.isoformat(),
        "summary": c,
        "findings": [
            {"level": f.level, "check": f.check,
             "unit_id": f.unit_id, "detail": f.detail}
            for f in report.findings if f.level != "PASS" or f.detail
        ],
    }
    print(json.dumps(out, indent=2))


# ---------- CLI ----------

def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="CORE unit store integrity checker (DC-77).")
    parser.add_argument("project", nargs="?", default=".",
                        help="Project root (default: current dir); "
                             "_memories/ will be found under it")
    parser.add_argument("--mode", choices=["schema", "integrity", "all"],
                        default="all",
                        help="Check mode (default: all)")
    parser.add_argument("--json", action="store_true", dest="as_json",
                        help="Emit JSON report instead of text")
    parser.add_argument("--today", default=None,
                        help="Override today's date as YYYY-MM-DD")
    args = parser.parse_args(argv)

    project = Path(args.project).resolve()
    memories_dir = project / "_memories"
    if not memories_dir.is_dir():
        # Try treating project arg as the memories dir directly
        memories_dir = project
    if not memories_dir.is_dir():
        print(f"error: _memories/ not found under {project}", file=sys.stderr)
        return 3

    today = parse_iso_date(args.today) if args.today else date.today()
    report = Report(memories_dir=memories_dir, mode=args.mode, today=today)

    units = _iter_active_units(memories_dir)
    if not units:
        print(f"error: no units found in {memories_dir}", file=sys.stderr)
        return 3

    if args.mode in ("schema", "all"):
        check_schema(units, memories_dir, report)
    if args.mode in ("integrity", "all"):
        check_integrity(units, memories_dir, report)

    if args.as_json:
        _json_report(report)
    else:
        _print_report(report)

    return report.exit_code()


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
