# Swarm Template — Research

Multi-source investigation, comparison, and fact-finding. Use this shape when the work is to gather information from multiple sources, surface contradictions, and integrate findings with calibrated confidence.

## Roster

- 2-3 Researchers, each with a different source specialty (internal/organizational, technical documentation, external/web)
- 1 Synthesizer — integrates findings with confidence levels
- 1 Fact-Checker — verifies claims, sources, and provenance independently
- No Guard needed (read-only swarm)

Hardware budget caps the roster — see `protocols/execution.md`. Default at constrained budget: 2 researchers + 1 synthesizer with the DM playing fact-checker.

## Phasing

The phase sequence is the standard research flow in `protocols/analysis.md` §10. Three pieces specific to research work warrant attention.

**Researchers announce source assignments at the start** — avoids duplication and makes coverage gaps visible.

**Fact-Checker independence discipline.** The fact-checker did not participate in the research phase. Fresh eyes are the point — the agent checks whether cited sources are real and accessible, whether they say what the researchers claim, whether outdated claims are being presented as current, and whether statistical claims are properly contextualized. This independence is the whole point — a fact-checker pulled from the same context as the researchers produces correlated verification, not independent verification.

**Confidence per finding** — High / Medium / Low with explicit rationale tied to source quality, convergence across independent sources, and the fact-check result. Uncalibrated confidence rolls into the synthesis as falsely-firm claims.

## Source priority

Configure per deployment. The general principle: internal/organizational systems (task trackers, document stores, chat platforms) tend to be "Current Truth" — recent decisions and context. External/reference systems (technical docs, web search) tend to be "Technical Grounding" — documentation and reference material. When sources conflict, prefer the more recent unless the older has stronger technical grounding, and always surface the conflict in the report rather than silently choosing one.

Examples — corporate: internal docs + chat = Current Truth, external search + web = Technical Grounding. Open-source: issues + PRs = Current Truth, published docs + web = Technical Grounding. Research: academic databases = Current Truth, web search = Technical Grounding.

## Context economics

For large documents, spawn temporary extractor agents to summarize source material into JSON key constraints before injecting into specialist researchers. Extract only fields relevant to each researcher's focus area. Prevents context-window bloat when researchers need to reference long sources.

## Output

Per `schemas/output.md` — integrated findings organized by topic or question, source provenance for every claim (which source, when accessed, confidence), confidence levels per finding with rationale, contradiction register (where sources disagreed and how it resolved), data void analysis (what's missing that would strengthen the report), recommendations for follow-up research if gaps are significant.
