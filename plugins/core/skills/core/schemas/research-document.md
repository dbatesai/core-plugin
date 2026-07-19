# Research Document Schema

The canonical shape for research documents persisted to `~/.core/research/`. The multi-agent analysis protocol at `protocols/analysis.md` (Research mode) produces documents in this shape.

---

## Frontmatter

Every research document begins with this frontmatter block:

```yaml
---
id: "res-YYYY-MM-DD-<topic-slug>"        # Unique identifier
title: "Human-readable title"             # Descriptive title
version: N                                # Integer, increments on supersession
topic: "<topic-slug>"                     # Kebab-case topic identifier
created: "ISO-8601"
updated: "ISO-8601"
source_skill: "analysis"                  # Which protocol produced this
source_session: "YYYY-MM-DD"
sources:                                  # Source material breakdown
  - type: "web|academic|internal|external-llm"
    count: N
sensitivity: "public|internal|restricted" # Inherits from the MOST restricted source material
derived-from-restricted: false            # true when any finding derives from restricted sources
supersedes: null                          # ID of what this replaced, or null
superseded_by: null                       # ID of replacement, or null
tags: ["tag1", "tag2"]                    # For discovery and overlap detection
status: "active|archived"                 # Active = current; archived = superseded
summary: "One-paragraph executive summary for index scanning"
---
```

Supersession is the audit trail — when a new research document replaces an older one on the same topic, write `supersedes` in the new document's frontmatter and `superseded_by` in the older one's. Nothing is deleted.

`sensitivity` and `derived-from-restricted` are required by the provenance discipline in `protocols/analysis.md §Research mode` — they gate external sharing. Sensitivity inherits from the most restricted source material the document draws on; `derived-from-restricted: true` whenever any finding rests on restricted-tier sources, even indirectly.

---

## Body structure

```markdown
# [Title]

## Executive Summary
One-paragraph synthesis of key findings and their significance.

## Research Questions
3–5 specific questions this research addresses.

## Findings
### Finding N: [Title]
**Confidence:** High | Medium | Low
**Sources:** [citation1], [citation2]
[Detailed finding with evidence]

## Source Bibliography
Complete source list with access dates and reliability assessment.
```

Three more sections are common but not required — include each when the research warrants it:

- **Convergence Analysis** — where multiple independent sources reached the same conclusion. Strong signal worth surfacing when it's there.
- **Contradictions** — where sources disagreed. Both positions, both with evidence; either resolved with reasoning or named as unresolved.
- **Data Voids** — what information would have strengthened this report but couldn't be found.
- **Recommendations** — actionable items derived from findings, when the research produced them.

---

## Library index (`~/.core/research/index.json`)

```json
{
  "version": 1,
  "last_updated": "ISO-8601",
  "documents": [
    {
      "id": "res-YYYY-MM-DD-topic-slug",
      "title": "Human-readable title",
      "topic": "topic-slug",
      "version": 1,
      "status": "active",
      "created": "ISO-8601",
      "updated": "ISO-8601",
      "path": "topics/topic-slug/topic-slug-v1.md",
      "tags": ["tag1", "tag2"],
      "summary": "One-paragraph summary"
    }
  ]
}
```

The index is the discovery surface — the agent reads it to find prior research on a topic before running a new investigation.
