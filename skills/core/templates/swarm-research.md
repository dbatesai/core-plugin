# CORE Swarm Template: Research

## Purpose

Multi-source investigation, comparison, and fact-finding. Research swarms produce integrated reports with source provenance and calibrated confidence levels.

## Default Roster

- **2-3 Researchers** -- each with a different source specialty or domain focus (e.g., one for internal/organizational sources, one for technical documentation, one for external/web sources)
- **1 Synthesizer** -- integrates findings into a coherent report with confidence levels
- **1 Fact-Checker** -- verifies claims, sources, and data provenance independently

## Guard

NOT needed. Research swarms are read-only -- no destructive operations.

## Hardware Scaling

| Machine | Recommended Agents |
|---|---|
| M5 Pro (24GB) | 3 agents (2 researchers + 1 synthesizer, DM plays fact-checker) |
| M4 Pro (48GB) | 5 agents (full roster) |

## DM Intervention

The DM is running this swarm in its own context — there is no second orchestrator. The DM intervenes directly via SendMessage, phase restarts, or a halt when the swarm drifts, a risk condition triggers, or research goes off-scope. These are course-correction tools, not levers for second-guessing normal role execution. Every intervention is logged.

## Phases

### Phase 1: Parallel Research

Each researcher focuses on different sources, domains, or tools. Researchers should announce their source assignments at the start to avoid duplication. Each researcher produces structured findings with explicit source citations for every claim.

### Phase 2: Cross-Reference

Researchers compare findings via SendMessage. The goal is to identify:
- **Contradictions** -- where sources disagree, note the specific claims and sources
- **Convergence** -- where independent sources agree, note this as a stronger signal
- **Gaps** -- where one researcher found information that others' sources lack entirely

### Phase 3: Fact-Check

The dedicated fact-checker verifies claims, sources, and data provenance. This agent did not participate in the research phase and brings fresh eyes. They check:
- Are cited sources real and accessible?
- Do the sources actually say what the researchers claim they say?
- Are there outdated claims being presented as current?
- Are statistical claims properly contextualized?

### Phase 4: Synthesis

The synthesizer produces an integrated report combining all verified findings. The report includes source provenance for every claim and calibrated confidence levels (High/Medium/Low) based on source quality, convergence, and fact-check results.

## Source Priority (Configure Per Deployment)

Establish source priority based on the available MCP tools and data sources in your environment. The general principle:

- **Internal/organizational systems** (e.g., task trackers, document stores, chat platforms, internal knowledge bases) = "Current Truth" — recent organizational knowledge, decisions, and context
- **External/reference systems** (e.g., technical docs, web search, public knowledge bases) = "Technical Grounding" — historical documentation and reference material

When sources conflict, prefer the more recent source unless the older source has stronger technical grounding. Always surface the conflict in the report rather than silently choosing one.

**Example configurations:**
- Corporate environment: internal document store + chat platform = Current Truth, external search + web = Technical Grounding
- Open-source project: issue tracker + pull-request system = Current Truth, published docs + web = Technical Grounding
- Research context: academic databases = Current Truth, web search = Technical Grounding

## Context Economics

Use Programmatic Extraction for large documents: spawn temporary extractor agents to summarize large documents into JSON key constraints before injecting into specialist researchers. This prevents context window bloat when researchers need to reference large source material. Extract only the fields relevant to each researcher's focus area.

## Output

Research report containing:
- Integrated findings organized by topic or question
- Source provenance for every claim (which source, when accessed, confidence)
- Confidence levels per finding (High/Medium/Low with rationale)
- Contradiction register (where sources disagreed and how it was resolved)
- Data void analysis (what information is missing that would strengthen the report)
- Recommendations for follow-up research if gaps are significant
