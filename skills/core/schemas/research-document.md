# Research Document Schema

The canonical format for all research documents persisted to the global research library at `~/.core/research/`. The multi-agent analysis protocol at `protocols/analysis.md` (Research mode) produces documents conforming to this schema. (Historical documents may carry `source_skill: "core-analysis"` from the pre-v2 sub-skill — now folded into the analysis protocol.)

---

## Frontmatter (YAML)

Every research document begins with this frontmatter block:

```yaml
---
id: "res-YYYY-MM-DD-<topic-slug>"        # Unique identifier
title: "Human-readable title"             # Descriptive title
version: N                                # Integer, increments on supersession
topic: "<topic-slug>"                     # Kebab-case topic identifier
created: "ISO-8601"                       # When first created
updated: "ISO-8601"                       # When last modified
source_skill: "analysis"                     # Which protocol produced this (historical docs may show "core-analysis" or "core-research")
source_session: "YYYY-MM-DD"              # Session date
sources:                                  # Source material breakdown
  - type: "web|academic|internal|external-llm"
    count: N
scoring:                                  # Quality rubric (see below)
  novelty: 1-5
  actionability: 1-5
  evidence_quality: 1-5
  relevance: 1-5
  composite: N.N                          # (N + A + E + R) / 4
organic_signals:                          # Accumulated over time
  citation_count: 0                       # Times cited by other research
  times_referenced: 0                     # Times loaded by DM/agents
  last_referenced: null                   # ISO-8601 or null
  superseded_by: null                     # ID of replacement, or null
  supersedes: null                        # ID of what this replaced, or null
tags: ["tag1", "tag2"]                    # For discovery and overlap detection
status: "active|archived"                 # Active = current; archived = superseded
summary: "One-paragraph executive summary for index scanning"
---
```

---

## Quality Scoring Rubric

Applied at creation time by the producing skill. Each dimension scored 1-5.

| Dimension | 1 | 2 | 3 | 4 | 5 |
|-----------|---|---|---|---|---|
| **Novelty** | Restates common knowledge | Minor new framing | Meaningful new connections | Significant new insight | Breakthrough finding |
| **Actionability** | Abstract only | Vague suggestions | Specific recommendations | Clear implementation steps | Ready-to-execute with code/config |
| **Evidence Quality** | No sources | Few sources, unchecked | Multiple sources, some verified | Multiple verified, fact-checked | Comprehensive, cross-referenced, all verified |
| **Relevance** | Tangentially related | Partially applicable | Applicable to current work | Directly addresses active need | Critical for upcoming decisions |

**Composite** = (Novelty + Actionability + Evidence Quality + Relevance) / 4

**Score thresholds:**
- 4.0+ → High-value, prioritize in library
- 3.0–3.9 → Solid, standard library entry
- 2.0–2.9 → Marginal, flag for improvement or archival
- < 2.0 → Below threshold, archive with reasoning

---

## Document Body Structure

After frontmatter, research documents follow this structure:

```markdown
# [Title]

## Executive Summary
One-paragraph synthesis of key findings and their significance.

## Research Questions
Numbered list of 3-5 specific questions this research addresses.

## Findings
### Finding N: [Title]
**Confidence:** High|Medium|Low
**Sources:** [citation1], [citation2]
[Detailed finding with evidence]

## Convergence Analysis
Where multiple sources independently reached the same conclusion.

## Contradictions
Where sources disagreed — both positions documented with evidence.

## Data Voids
What information would strengthen this research but couldn't be found.

## Recommendations
Actionable items derived from findings.

## Source Bibliography
Complete source list with access dates and reliability assessment.
```

---

## Library Index Schema (`~/.core/research/index.json`)

```json
{
  "version": 1,
  "last_updated": "ISO-8601",
  "stats": {
    "total_documents": 0,
    "active_documents": 0,
    "archived_documents": 0,
    "topics": 0,
    "avg_composite_score": 0
  },
  "documents": [
    {
      "id": "res-YYYY-MM-DD-topic-slug",
      "title": "Human-readable title",
      "topic": "topic-slug",
      "version": 1,
      "status": "active",
      "composite_score": 4.5,
      "created": "ISO-8601",
      "updated": "ISO-8601",
      "path": "topics/topic-slug/topic-slug-v1.md",
      "tags": ["tag1", "tag2"],
      "summary": "One-paragraph summary",
      "organic_signals": {
        "citation_count": 0,
        "times_referenced": 0,
        "last_referenced": null
      }
    }
  ],
  "topic_index": {
    "topic-slug": {
      "active_version": 1,
      "document_count": 1,
      "first_researched": "ISO-8601",
      "last_updated": "ISO-8601"
    }
  }
}
```

---

## Topic Metadata Schema (`~/.core/research/topics/<slug>/meta.json`)

```json
{
  "topic": "topic-slug",
  "active_document": "topic-slug-v1.md",
  "version_history": [
    {
      "version": 1,
      "date": "YYYY-MM-DD",
      "status": "active",
      "path": "topic-slug-v1.md"
    }
  ],
  "related_topics": ["other-topic-slug"]
}
```
