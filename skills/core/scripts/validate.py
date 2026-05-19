#!/usr/bin/env python3
"""
CORE v2 validation runner.
Usage: python3 validate.py <project-path>

Reads test corpus from <project-path>/_memories/_validation/tests/test-*.yaml
Runs Tier 1 retrieval simulation (grep) for each test
Scores precision + recall against expected/forbidden unit lists
Writes report to <project-path>/_outputs/validation/<date>/REPORT.md

Layout per DC-68: units are FLAT at <project>/_memories/, not in type-subdirectories.
"""
import sys, re
from pathlib import Path
from datetime import datetime

def parse_frontmatter(content):
    """Parse YAML frontmatter from a markdown file content.
    Uses PyYAML if available, otherwise a fallback parser that handles
    multi-line lists.
    """
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return {}
    fm_text = match.group(1)
    try:
        import yaml
        return yaml.safe_load(fm_text) or {}
    except ImportError:
        pass
    # Fallback: handle scalars + multi-line lists
    result = {}
    current_key = None
    current_list = None
    for line in fm_text.split('\n'):
        if not line.strip():
            continue
        # List continuation
        if line.startswith('  - ') or line.startswith('- '):
            value = line.lstrip()[2:].strip().strip('"').strip("'")
            if current_list is not None:
                current_list.append(value)
            continue
        # Top-level key
        if ':' in line and not line.startswith(' '):
            if current_key and current_list is not None:
                result[current_key] = current_list
                current_list = None
            k, _, v = line.partition(':')
            k = k.strip()
            v = v.strip()
            current_key = k
            if not v:
                current_list = []
            else:
                if v.startswith('[') and v.endswith(']'):
                    result[k] = [x.strip().strip('"').strip("'") for x in v[1:-1].split(',') if x.strip()]
                else:
                    result[k] = v.strip('"').strip("'")
                current_key = None
                current_list = None
    if current_key and current_list is not None:
        result[current_key] = current_list
    return result

def load_tests(project_path):
    tests_dir = Path(project_path) / "_memories/_validation/tests"
    tests = []
    if not tests_dir.exists():
        return tests
    for f in sorted(tests_dir.glob("test-*.yaml")):
        content = f.read_text()
        fm = parse_frontmatter(content)
        if fm and 'query' in fm:
            tests.append(fm)
    return tests

STOPWORDS = {
    # Length-3 common words that survive length>=3 filter but carry no signal
    "the", "and", "for", "are", "was", "but", "not", "you", "all", "any",
    "can", "had", "has", "his", "her", "how", "its", "may", "now", "one",
    "our", "out", "own", "see", "she", "two", "use", "via", "way", "who",
    "why", "yes", "yet",
    # Length-4+ common words
    "what", "where", "which", "would", "could", "should", "their", "there",
    "these", "those", "about", "after", "again", "before", "being", "below",
    "between", "during", "other", "while", "every", "based", "into", "than",
    "then", "this", "that", "they", "from", "have", "with", "your", "just",
    "like", "make", "more", "much", "only", "over", "some", "such", "very",
    "when", "will", "also", "back", "been", "both", "down", "even", "ever",
    "here", "many", "much", "must", "need", "same", "well",
    # Negations and contractions reduced after punctuation strip
    "dont", "isnt", "wont", "cant", "doesnt", "wouldnt", "couldnt",
}

def simulate_retrieval_tier1(query, project_path, top_k=3):
    """Tier 1 retrieval simulator with term-density ranking.

    Approach (improved per Phase 7 Fault F1 + ANALYSIS.md):
    1. Extract candidate terms from query (length > 4, not in STOPWORDS).
    2. For each unit file, count distinct terms matched in body + filename.
       Filename matches count 2x (filename slug is a strong intent signal).
    3. Rank candidates by score descending; return top-K.
    4. Floor: any unit with zero matches is dropped regardless of K.

    top_k is scaled by the caller to match `len(expected_memories) + 1`
    (test-by-test) so precision can actually reach 0.8 when the expected
    unit is the top-ranked match. Default 3 if not scaled.

    This replaces the v1 OR-of-terms approach that surfaced every unit
    containing any term — structurally noisy on a 60-unit corpus.

    Flat layout per DC-68 — walks _memories/*.md (recursive into archive
    subfolders is excluded).
    """
    units_dir = Path(project_path) / "_memories"
    raw_terms = [t.lower().strip(".,?!()[]\"'") for t in query.split()]
    # length >= 3 keeps acronyms (MCP, v2) and short content words (flat,
    # unit, store, code) while STOPWORDS filters out the common noise.
    terms = [t for t in raw_terms if len(t) >= 3 and t not in STOPWORDS]
    if not terms:
        return []

    scored = []
    for f in units_dir.rglob("*.md"):
        path_str = str(f)
        if "archive" in path_str or "cold-storage" in path_str or "_validation" in path_str:
            continue
        if f.name.startswith("INDEX") or f.name.startswith("README") or f.name.startswith("_"):
            continue
        try:
            content = f.read_text().lower()
            slug = f.stem.lower()
            body_hits = sum(1 for t in terms if t in content)
            slug_hits = sum(1 for t in terms if t in slug)
            score = body_hits + 2 * slug_hits
            if score > 0:
                scored.append((score, f.stem))
        except Exception:
            pass

    scored.sort(key=lambda x: (-x[0], x[1]))
    return [stem for _, stem in scored[:top_k]]

def score_precision_recall(retrieved, expected, forbidden):
    ret_set = set(retrieved)
    exp_set = set(expected) if expected else set()
    forb_set = set(forbidden) if forbidden else set()

    clean_ret = ret_set - forb_set
    tp = len(clean_ret & exp_set)
    fp = len(ret_set & forb_set)
    fn = len(exp_set - ret_set)

    if not exp_set:
        precision = 0.0 if fp > 0 else 1.0
        recall = 1.0
    else:
        precision = tp / max(len(clean_ret), 1)
        recall = tp / max(len(exp_set), 1)
    return round(precision, 2), round(recall, 2)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 validate.py <project-path>")
        sys.exit(1)

    project_path = sys.argv[1]
    tests = load_tests(project_path)

    if not tests:
        print(f"No tests found in {project_path}/_memories/_validation/tests/")
        sys.exit(0)

    results = []
    for t in tests:
        query = t.get('query', '')
        expected = t.get('expected_memories', [])
        forbidden = t.get('forbidden_memories', [])
        if isinstance(expected, str):
            expected = [expected] if expected else []
        if isinstance(forbidden, str):
            forbidden = [forbidden] if forbidden else []

        # Scale top_k to the test's expected-set size. Strict top_k (no
        # noise buffer) means PASS requires the expected unit(s) to be the
        # top-ranked candidates — the meaningful success criterion for a
        # ranked-retrieval simulator. If the simulator places the expected
        # unit at rank 1 for a single-expected test, P=1.0 and R=1.0.
        top_k = max(1, len(expected))
        retrieved = simulate_retrieval_tier1(query, project_path, top_k=top_k)
        p, r = score_precision_recall(retrieved, expected, forbidden)

        if p >= 0.8 and r >= 0.8:
            status = "PASS"
        elif p < 0.5 or r < 0.5:
            status = "FAIL"
        else:
            status = "INVESTIGATE"

        results.append({
            'query': query,
            'precision': p,
            'recall': r,
            'status': status,
            'retrieved': retrieved[:5],
            'expected': expected,
        })
        icon = "PASS" if status == "PASS" else ("FAIL" if status == "FAIL" else "INV")
        print(f"[{icon}] P={p} R={r} -- {query[:60]}")

    passes = sum(1 for r in results if r['status'] == 'PASS')
    fails = sum(1 for r in results if r['status'] == 'FAIL')
    total = len(results)

    date_str = datetime.now().strftime("%Y-%m-%d")
    report_dir = Path(project_path) / f"_outputs/validation/{date_str}"
    report_dir.mkdir(parents=True, exist_ok=True)

    report_lines = [
        f"# Validation Report -- {date_str}\n\n",
        f"**Results: {passes}/{total} pass, {fails} fail**\n\n",
        "| Status | P | R | Query |\n",
        "|---|---|---|---|\n",
    ]
    for r in results:
        report_lines.append(f"| {r['status']} | {r['precision']} | {r['recall']} | `{r['query'][:70]}` |\n")

    report_lines.append("\n## Detail\n\n")
    for r in results:
        report_lines.append(f"**{r['query']}**  \nExpected: {r['expected']}  \nRetrieved (top 5): {r['retrieved']}\n\n")

    report_path = report_dir / "REPORT.md"
    report_path.write_text(''.join(report_lines))
    print(f"\nReport: {report_path}")

    if fails > 0:
        print(f"\n{fails} FAIL(s) -- PAUSE-AND-SURFACE TRIGGER if any precision or recall < 0.5")
        sys.exit(1)

if __name__ == "__main__":
    main()
