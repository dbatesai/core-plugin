# Agent memory and context management: what the published evidence supports

Research digest for the CORE rewrite. Compiled 2026-11-09. Every claim in the evidence lists carries a tag that says where it came from. "Finding" paragraphs and "Design rule" lists sum up the tagged evidence beneath them.

## Summary (15 lines)

1. Longer input makes models less reliable, well before the context limit. Several peer-reviewed papers and one vendor report agree (§1).
2. Text that looks relevant but is wrong does more damage than unrelated text (§1, §2).
3. An always-loaded project file is not free. One controlled study found no significant gain in task success and about 20% more cost (§1).
4. Retrieval for memory should favour precision. Results improve, then fall, as more items are injected (§2).
5. For agents that can run tools, plain files plus search come close to, or beat, vector pipelines in several 2025–2026 tests, at a cost in latency and tokens. Cursor reports the opposite for large codebases (§2).
6. Strong models do better when they choose what to save and are told what memory is for. A rigid "record only X" rule cost performance in Anthropic's tests (§3).
7. Automatic extraction pipelines omit and invent memories. Wrong notes get trusted later (§3).
8. Changed facts are where memory fails. Overwrite or invalidate at write time, and keep the old value as dated history (§4).
9. Summaries lose specifics. Systems that keep raw records searchable beat summary-only memory (§5).
10. LoCoMo, DMR and LongMemEval-S fit inside a modern context window, and vendor scores on them conflict. Do not pick a design from those numbers (§6).
11. Measure with and without the feature on the same tasks, with repeated runs, graded on outcomes. In one randomized trial, developers' own sense of speed-up had the wrong sign (§7).
12. LLM judges show position, verbosity and self-preference bias. Blind them, swap the order, and check them against human labels (§7).
13. Proactive help raised task completion 12–18% in one study, but more frequent suggestions halved user preference. Speaking at task boundaries worked best (§8).
14. Memory files and hooks are a demonstrated attack path, including against Claude Code. Claude Code users approved about 93% of permission prompts, so approval alone is weak (§8, §9).
15. "No data" must never read as "healthy". Use three states, a heartbeat, and a known-answer probe (§10).

## How to read the tags

- `[OPENED url]` means I fetched that page in this session. The text in quotes right after it is copied from the page, 25 words or fewer.
- `[SEARCH-ONLY url]` means I saw only a search extract. Treat it as a lead, not a fact.
- Source type comes first in each bullet. **PR** = peer-reviewed, with the venue shown on a page I opened. **PP** = preprint. **VR** = vendor report, vendor blog or vendor docs. **PO** = practitioner opinion or community guide. **STD** = standards body or open-source project documentation.
- A few sources carry a plain-word label instead, such as "security researcher" or "workshop paper".
- PDFs were read as extracted text. Line breaks inside a quote were joined. Nothing else was changed.
- Every quoted passage was checked by script against the saved page text: exact match, 25 words or fewer.
- "Inference" marks my own reasoning. It is not sourced.

---

## 1. Context rot

**Finding.** Models get less reliable as input grows. The drop starts far below the context limit. Related-but-wrong text makes it worse. Position can matter, but not in every test.

**What Chroma measured and found.** (VR. Technical report dated July 14, 2025. Not peer-reviewed.)

- Who wrote it. A company that works on retrieval. [OPENED https://research.trychroma.com/context-rot] "Interested in working on improving retrieval for AI applications? Chroma is Hiring"
- The code is public. [OPENED https://research.trychroma.com/context-rot] "The complete codebase to replicate our results."
- Scope: 18 models. Task held fixed. Only input length changed. [OPENED https://research.trychroma.com/context-rot] "we evaluate 18 LLMs, including the state-of-the-art GPT-4.1, Claude 4, Gemini 2.5, and Qwen3 models"
- Tasks: a needle-in-a-haystack extension, a conversational memory test (LongMemEval), and a copy-the-text test. [OPENED https://research.trychroma.com/context-rot] "a synthetic task in which models replicate a series of repeated words"
- Design: one variable at a time. [OPENED https://research.trychroma.com/context-rot] "our experiments hold task complexity constant while varying only the input length"
- Headline. [OPENED https://research.trychroma.com/context-rot] "Across all experiments, model performance consistently degrades with increasing input length."
- Distractors are near-misses. [OPENED https://research.trychroma.com/context-rot] "Distractors are topically related to the needle, but do not quite answer the question"
- One near-miss is enough to hurt. [OPENED https://research.trychroma.com/context-rot] "Even a single distractor reduces performance relative to the baseline (needle only), and adding four distractors compounds this degradation further."
- Memory-shaped test. Same question, two inputs: about 300 relevant tokens, or the full history of about 113k tokens. [OPENED https://research.trychroma.com/context-rot] "Across all models, we see significantly higher performance on focused prompts compared to full prompts." "Focused prompts average to ~300 tokens" "These prompts average out to ~113k tokens."
- Position did not matter in their needle test. [OPENED https://research.trychroma.com/context-rot] "Testing across 11 needle positions, we find no notable variation in performance for this specific NIAH task."
- Tidy, coherent filler was harder than shuffled filler. [OPENED https://research.trychroma.com/context-rot] "Shuffling the haystack and removing local coherence consistently improves performance."
- Models differ in how they fail. Some abstain. Some invent. [OPENED https://research.trychroma.com/context-rot] "Claude models consistently exhibit the lowest hallucination rates."
- Limits they state. [OPENED https://research.trychroma.com/context-rot] "this evaluation is not exhaustive of real-world use cases"
- Scoring used an LLM judge. [OPENED https://research.trychroma.com/context-rot] "We evaluate model outputs using an aligned GPT-4.1 judge"

**Independent support.**

- PR (TACL 2024). Position matters in multi-document QA and key-value lookup. [OPENED https://aclanthology.org/2024.tacl-1.9/] "performance is often highest when relevant information occurs at the beginning or end of the input context"
- PR (ACL 2024, per the arXiv comment line). The drop comes early. [OPENED https://arxiv.org/abs/2402.14848] "a notable degradation in LLMs' reasoning performance at much shorter input lengths than their technical maximum"
- PR (ICML 2025, per the arXiv comment line). When the question does not share words with the answer, the drop is steep. [OPENED https://arxiv.org/abs/2502.05167] "At 32K, for instance, 11 models drop below 50% of their strong short-length baselines."
- PR (ICML 2023, per the arXiv comment line). Irrelevant text in a problem statement hurts. [OPENED https://arxiv.org/abs/2302.00093] "the model performance is dramatically decreased when irrelevant information is included"
- PP. Very long dialogues. [OPENED https://arxiv.org/abs/2510.27246] "even LLMs with 1M token context windows (with and without retrieval-augmentation) struggle as dialogues lengthen"
- PP. Long multi-turn sessions go wrong and stay wrong. [OPENED https://arxiv.org/abs/2505.06120] "when LLMs take a wrong turn in a conversation, they get lost and do not recover"

**What Anthropic's context-engineering post says.** (VR. Engineering blog, 29 Sep 2025.)

- On context rot. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "as the number of tokens in the context window increases, the model’s ability to accurately recall information from that context decreases"
- On the attention budget. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "LLMs have an “attention budget” that they draw on when parsing large volumes of context"
- The goal it sets. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome"
- Just-in-time retrieval. Keep pointers, load on demand. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools"
- Its cost. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "runtime exploration is slower than retrieving pre-computed data"
- Compaction can lose what matters later. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later"
- How to tune a compaction prompt. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "Start by maximizing recall to ensure your compaction prompt captures every relevant piece of information from the trace"
- The cheapest safe step. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "One of the safest lightest touch forms of compaction is tool result clearing"
- Structured note-taking. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "the agent regularly writes notes persisted to memory outside of the context window"
- Sub-agents keep search noise out of the main context. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)"
- How Claude Code mixes the two. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time"

**Related evidence on always-loaded files.**

- VR docs. Put the question last. [OPENED https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips.md] "Queries at the end can improve response quality by up to 30 percent in tests, especially with complex, multidocument inputs."
- VR docs. Long instruction files are followed less well. [OPENED https://code.claude.com/docs/en/memory.md] "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."
- PP (ETH Zurich). Repository context files, tested with and without. [OPENED https://arxiv.org/abs/2602.11988] "providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average"
- Its test set: SWE-bench tasks plus a new set from repositories that ship such files. [OPENED https://arxiv.org/pdf/2602.11988] "The benchmark contains 138 unique instances"
- Same paper. Human-written files did a little better, but not significantly better than none. [OPENED https://arxiv.org/pdf/2602.11988] "Developer-provided context files improve agent performance by 2.4% on average (p = 21%)"
- Same paper. Why cost rose: agents obeyed the files and did more. [OPENED https://arxiv.org/pdf/2602.11988] "This leads to increased exploration, testing, and reasoning by coding agents"
- Same paper, body. The authors advise against machine-written files. [OPENED https://arxiv.org/pdf/2602.11988] "We therefore suggest omitting LLM-generated context files for the time being"
- Same paper. Their advice for human-written files. [OPENED https://arxiv.org/pdf/2602.11988] "Human-written context files should only include instructions required for coding agents that are not already present in the README"
- Same paper. Overviews did not help agents find files. [OPENED https://arxiv.org/abs/2602.11988] "repository overviews, although popular and recommended by model providers, are not helpful"

**Design rule.**

- Give the always-loaded layer a hard size budget. Keep it an index, not a store. Load detail by path when the task needs it.
- Never inject two versions of one fact. A stale near-copy is a distractor.
- Put standing material first and the live task last.
- Do not rely on position tricks alone. One test found a strong position effect. Another found none.
- Do not write a repository overview into memory. The one study that tested overviews found no benefit.

---

## 2. Retrieval precision versus recall

**Finding.** More retrieved items help, then hurt. Wrong-but-similar items hurt most. For agents that can run tools, search over plain files is a strong baseline. Embeddings still win some one-shot retrieval tests and some large-codebase tests.

**Evidence that irrelevant or near-miss items hurt.**

- PP. An inverted U as passages are added. [OPENED https://arxiv.org/pdf/2410.05983] "increasing the number of retrieved passages initially improves performance, but then leads to a sharp decline or plateau"
- Same paper. The pattern shows with a strong retriever. [OPENED https://arxiv.org/pdf/2410.05983] "With a strong retriever, performance exhibits an “inverted-U pattern”"
- Same paper. Why: more passages lower precision. [OPENED https://arxiv.org/pdf/2410.05983] "the inclusion of additional documents can reduce precision, with irrelevant or misleading passages detracting LLMs from overall performance"
- Same paper. Better retrievers can return more convincing wrong passages. [OPENED https://arxiv.org/pdf/2410.05983] "‘hard negatives’ from stronger retrievers might confuse the LLM generation even more than those from weaker retrievers"
- PR (SIGIR 2024, shown on the arXiv HTML page). High-ranked near-misses hurt. [OPENED https://arxiv.org/abs/2401.14887] "the retriever's highest-scoring documents that are not directly relevant to the query (e.g., do not contain the answer) negatively impact the effectiveness of the LLM"
- Same paper. Random text did not hurt in their setup. [OPENED https://arxiv.org/abs/2401.14887] "adding random documents in the prompt improves the LLM accuracy by up to 35%"
- PP. Retrieval can make answers worse. [OPENED https://arxiv.org/abs/2310.01558] "retrieval augmentation can sometimes have a negative effect on performance"
- PR (ACL 2024). In long conversations, five retrieved notes helped. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "There is a noticeable 5% improvement with gpt-3.5-turbo when the input is top 5 relevant observations instead of pure conversation logs."
- Same paper. More notes erased the gain. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "This improvement falters with an increase in the number of retrieved observations"
- VR (Anthropic, Nov 2026). Injected memory has a standing cost. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Injected memories use up valuable tokens, and an incorrect note can be carried into every session."
- PO (Simon Willison, May 2025). Memory surfaced where it was not wanted. [OPENED https://simonwillison.net/2025/May/21/chatgpt-new-memory/] "an enormously complex set of extra conditions that can invisibly affect the output of the models"

**Evidence on top-k size.**

- PR (ICLR 2025). The best budget depends on the reader model. [OPENED https://arxiv.org/pdf/2410.10813] "while Llama 3.1 8B Instruct’s performance drops sharply beyond 3k retrieved tokens, GPT-4o continues to improve even with over 20k retrieved tokens"
- VR (Anthropic, Sep 2024; retrieval over code, fiction and papers). Twenty chunks beat ten and five in their tests. [OPENED https://www.anthropic.com/news/contextual-retrieval] "We tried delivering 5, 10, and 20 chunks, and found using 20 to be the most performant of these options" "(codebases, fiction, ArXiv papers, Science Papers)"
- Same post. It still warns of a ceiling. [OPENED https://www.anthropic.com/news/contextual-retrieval] "more information can be distracting for models so there's a limit to this"
- VR (GitHub, Jan 2026). Copilot's first memory system used no ranking at all, only recency. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "we retrieve the most recent memories for the target repository and include them in the prompt"
- Inference: there is no single right k. The safe reading is "small, and proven by test".

**When lexical search or plain file search is competitive.**

- PR (NeurIPS 2021 Datasets and Benchmarks, per the arXiv comment line). BM25 holds up in zero-shot tests across 18 datasets. [OPENED https://arxiv.org/abs/2104.08663] "Our results show BM25 is a robust baseline" "a careful selection of 18 publicly available datasets"
- VR (Anthropic, Sep 2024). Lexical search wins on exact tokens. [OPENED https://www.anthropic.com/news/contextual-retrieval] "It's particularly effective for queries that include unique identifiers or technical terms."
- Same post. The two together beat embeddings alone. [OPENED https://www.anthropic.com/news/contextual-retrieval] "Embeddings+BM25 is better than embeddings on their own"
- PP (listed on Amazon Science). An agent with only keyword search tools reached over 90% of a vector pipeline's scores, per the abstract. [OPENED https://arxiv.org/abs/2602.23368] "of the performance metrics compared to traditional RAG systems without using a standing vector database"
- Same paper. Where it fits. [OPENED https://arxiv.org/abs/2602.23368] "simple to implement, cost effective, and is particularly useful in scenarios requiring frequent updates to knowledge bases"
- Its Amazon listing. [OPENED https://www.amazon.science/publications/keyword-search-is-all-you-need-achieving-rag-level-performance-without-vector-databases-using-agentic-tool-use] "Keyword search is all you need: Achieving RAG-level performance without vector databases using agentic tool use"
- PP. Coding agents working over files beat prior long-context methods. [OPENED https://arxiv.org/abs/2603.20432] "these agents outperform published state-of-the-art by 17.3% on average"
- Counter-evidence, PR (ICLR 2025). For one-shot retrieval over chat history, embeddings beat BM25. [OPENED https://arxiv.org/pdf/2410.10813] "Both dense retrieval embeddings have significantly higher performance than the BM25 sparse retrieval method."
- Same paper. Adding extracted facts to the index key helped. [OPENED https://arxiv.org/pdf/2410.10813] "(9.4% higher recall@k) and downstream question answering (5.4% higher accuracy)"

**The Letta filesystem result.** (VR. Letta blog, 12 Aug 2025.)

- The claim. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "achieve 74.0% accuracy on LoCoMo by simply storing conversation histories in files"
- The comparison. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "significantly above Mem0's reported 68.5% score for their top-performing graph variant"
- Caveat one. It was not grep alone. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "Files in Letta are automatically parsed and embedded to enable semantic (vector) search over their contents."
- Caveat two. The agent was forced to start with the semantic tool. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "The agent must start by calling search_files"
- Their explanation is iteration, not the tool. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "they can continue searching until the right data is found"
- And familiarity. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "simpler tools are more likely to be in the training data of an agent"

**Agentic search over files versus vector retrieval, for agent and code context.**

- PP (LongMemEval-V2, May 2026, marked "Work in Progress"). Trajectories stored as files and searched by a coding agent beat the best RAG baseline. [OPENED https://arxiv.org/abs/2605.12493] "AgentRunbook-C achieves the best performance with 72.5% average accuracy, outperforming the strongest RAG baseline (48.5%) and the off-the-shelf coding agent baseline (69.3%)"
- Same paper. The price. [OPENED https://arxiv.org/abs/2605.12493] "coding agent based methods have high latency costs"
- Same paper, body. A manifest and a short workflow note made the file approach better. [OPENED https://arxiv.org/pdf/2605.12493] "coding agents are more effective as memory controllers when paired with explicit workflow guidance, manifests, and trajectory inspection tools"
- VR (Anthropic, Nov 2026). A maintained wiki helped when answers span documents. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Claude scored 87% when it consulted the wiki, compared with 73% when it used search alone"
- That test was small. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "One test asked 24 questions about the merger"
- Same post. It did not help when one document held the answer. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "the wiki showed no clear gain in performance relative to search"
- Same post. On a 25-question test over a large file corpus, search plus wiki beat search alone by a few points. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Claude’s aggregate score rose from 54% to 61% as that wiki grew, compared with 53% when it had access to the search tool alone"
- Same post. The wiki alone was worse than search alone. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Claude’s best score was 48% when it used only the wiki to answer questions."
- PP (MERIT, Jul 2026). Mixing a fact store with embedding retrieval was worse than the fact store. [OPENED https://arxiv.org/abs/2609.05441] "the hybrid is worse than the fact store alone"

**What Anthropic has said about Claude Code.**

- VR. The context-engineering post gives the reason. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "effectively bypassing the issues of stale indexing and complex syntax trees"
- VR (Agent SDK post). The trade-off, stated plainly. [OPENED https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk] "Semantic search is usually faster than agentic search, but less accurate, more difficult to maintain, and less transparent."
- Same post. The advice. [OPENED https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk] "we suggest starting with agentic search, and only adding semantic search if you need faster results or more variations"
- PO (Boris Cherny of the Claude Code team, podcast transcript, May 2025). Early versions indexed the codebase. [OPENED https://www.latent.space/p/claude-code] "very, very early versions of Claude actually used RAG"
- Same transcript. Plain search replaced it. [OPENED https://www.latent.space/p/claude-code] "it outperformed everything. By a lot."
- Same transcript. He says the basis was mostly informal. [OPENED https://www.latent.space/p/claude-code] "This was just vibes, so internal vibes. There's some internal benchmarks also, but mostly vibes."
- Same transcript. The index problem. [OPENED https://www.latent.space/p/claude-code] "the code drifts out of sync"

**Counter-evidence for large codebases.** (VR. Cursor blog, 6 Nov 2025.)

- Cursor has invested in the approach it is testing. [OPENED https://cursor.com/blog/semsearch] "we’ve trained our own embedding model and built indexing pipelines for fast retrieval"
- Offline test, tools with and without semantic search. [OPENED https://cursor.com/blog/semsearch] "Achieving on average 12.5% higher accuracy in answering questions (6.5%–23.5% depending on the model)."
- Online A/B test. The effect on kept code was small, larger in big repositories. [OPENED https://cursor.com/blog/semsearch] "We see agent code retention increases by 0.3% when semantic search is available." "This effect increases to 2.6% on large codebases with 1,000 files or more."
- Their conclusion keeps grep. [OPENED https://cursor.com/blog/semsearch] "the combination of these two leads to the best outcomes"
- PO (Cline's own blog, May 2025). The staleness argument. [OPENED https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing] "An index, by definition, is a snapshot frozen in time."

**Design rule.**

- Start with plain files, a short index, and the agent's own search tools. This is the option with the most support for a small plugin.
- Add an embedding index only after a measured retrieval miss on your own tasks. Cursor's data says large repositories are where it may pay.
- Inject few notes. Prove each increase with a test.
- Use exact-match search for paths, flags, error codes and identifiers.
- Give the agent a manifest of what exists and where. A pile of files is not enough.
- Budget for the cost. File search is slower and uses more tokens than a lookup.

---

## 3. Memory write policies

**Finding.** No study I opened compares "every turn", "session end" and "agent-initiated" head to head. The evidence does show four things. Writing everything hurts. Extraction pipelines drop and invent facts. Strong models choose well when told what memory is for. Background consolidation can repair notes, but only if it checks them against a ground truth.

**Generative Agents.** (PR, UIST 2023, shown in the paper header. A social simulation, not a coding agent.)

- The setting. [OPENED https://arxiv.org/pdf/2304.03442] "A community of 25 unique agents inhabits Smallville."
- Recency. [OPENED https://arxiv.org/pdf/2304.03442] "Recency assigns a higher score to memory objects that were recently accessed"
- Recency is exponential decay. [OPENED https://arxiv.org/pdf/2304.03442] "Our decay factor is 0.995."
- Importance is a model-assigned score at write time. [OPENED https://arxiv.org/pdf/2304.03442] "we find that directly asking the language model to output an integer score is effective"
- The three are added with equal weight. [OPENED https://arxiv.org/pdf/2304.03442] "In our implementation, all 𝛼s are set to 1."
- Reflection is triggered by accumulated importance. [OPENED https://arxiv.org/pdf/2304.03442] "we generate reflections when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold"
- Reflections keep their evidence. [OPENED https://arxiv.org/pdf/2304.03442] "including pointers to the memory objects that were cited"
- Ablation. Each part mattered for believability, as ranked by people. [OPENED https://arxiv.org/pdf/2304.03442] "Performance degraded with the removal of each component in the ablation conditions" "The study followed a within-subjects design, where 100 participants compared interview responses"
- Failure one: missed retrieval. [OPENED https://arxiv.org/pdf/2304.03442] "they can fail to retrieve the correct instances from their memory"
- Failure two: invented detail. [OPENED https://arxiv.org/pdf/2304.03442] "At times, the agents hallucinated embellishments to their knowledge."

**Extraction on every turn: mem0.** (PP. The paper's contact address is at mem0.ai.)

- When it runs. [OPENED https://arxiv.org/pdf/2504.19413] "The extraction phase initiates upon ingestion of a new message pair"
- ADD. [OPENED https://arxiv.org/pdf/2504.19413] "ADD for creation of new memories when no semantically equivalent memory exists"
- UPDATE. [OPENED https://arxiv.org/pdf/2504.19413] "UPDATE for augmentation of existing memories with complementary information"
- DELETE. [OPENED https://arxiv.org/pdf/2504.19413] "DELETE for removal of memories contradicted by new information"
- NOOP. [OPENED https://arxiv.org/pdf/2504.19413] "NOOP when the candidate fact requires no modification to the knowledge base"
- The model picks the operation. [OPENED https://arxiv.org/pdf/2504.19413] "Rather than using a separate classifier, we leverage the LLM’s reasoning capabilities to directly select the appropriate operation"
- Their own table shows the cost of extraction. Reading the whole conversation scored higher. [OPENED https://arxiv.org/pdf/2504.19413] "a full-context method that ingests a chunk of roughly 26,000 tokens still achieves the highest J score (approximately 73%)"

**The risk of storing inferences as facts.**

- PP (HaluMem). Extraction accuracy was low across products. [OPENED https://arxiv.org/pdf/2511.03506] "all systems have accuracy (Acc.) below 62%, reflecting a high proportion of hallucinations"
- A conflict to keep in mind. Some HaluMem authors also wrote MemOS, one of the systems tested, and MemOS came out well. [OPENED https://arxiv.org/pdf/2511.03506] "Zhiyu Li, Shichao Song, Chenyang Xi, Hanyu Wang, Chen Tang, Simin Niu, Ding Chen" "MemOS and Supermemory perform the best"
- Same paper. Updates were often missed. [OPENED https://arxiv.org/pdf/2511.03506] "most systems suffer omission rates above 50%"
- Same paper, abstract. Errors compound. [OPENED https://arxiv.org/abs/2511.03506] "existing memory systems tend to generate and accumulate hallucinations during the extraction and updating stages"
- PR (ICLR 2025). Two commercial assistants, tested by hand. [OPENED https://arxiv.org/pdf/2410.10813] "ChatGPT tended to overwrite crucial information as the chat continues, while Coze often failed to record indirectly provided user information"
- That hand test was small and short. [OPENED https://arxiv.org/pdf/2410.10813] "we randomly selected 97 questions and created a short chat history of 3-6 sessions"
- VR (Anthropic, Nov 2026). A wrong note is believed. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "a note that’s wrong from the start or that drifts as the environment changes can be read, and trusted, by Claude in a later session"
- Same post. Better models began to separate checked from unchecked. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "began marking which facts it had checked and which were still unconfirmed"
- PP (MERIT). A model-based extractor swallowed planted bad records that a rigid pattern rejected. [OPENED https://arxiv.org/pdf/2609.05441] "the LLM extractor ingests corrupted records that the rigid patterns rejected"

**Agent-initiated writing: Anthropic's November 2026 post.** (VR. Published 6 Nov 2026. Small samples, as quoted below and in §2.)

- Writing everything failed. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Sonnet 3.7 wrote 413 memory files across 225 folders and earned one badge"
- Writing little worked. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "wrote nine files in two folders, plus a single top-level file called global.md, and earned four badges"
- Why the big store failed. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Sonnet 3.7’s detailed record was continuously going out of date"
- What not to store. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "can be read off the screen every turn, so storing it is redundant"
- What to store. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "memory files about strategy, plans, and tested rules exist only if Claude works them out"
- How to instruct. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "it helps to tell Claude what memory is for, but not how to use it"
- A fixed rule backfired. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "both Opus 5 and Opus 4.7 lost much of the performance boost that memory gave them"
- Older models needed a nudge to read memory first. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "nearly doubled its benchmark score"
- Sample size, in their words. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "We compared the memory folders from one run each"

**Other vendor guidance on what and when.**

- VR docs (Claude Code auto memory). Skip what the repo already says. [OPENED https://code.claude.com/docs/en/memory.md] "Claude skips anything it can derive from the codebase, such as architecture, file paths, or debugging fixes."
- Same docs. Not every session. [OPENED https://code.claude.com/docs/en/memory.md] "Claude doesn't save something every session."
- VR docs (Anthropic memory tool). The built-in instruction assumes interruption. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "ASSUME INTERRUPTION: Your context window might be reset at any moment"
- Same docs. Against file sprawl. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "Do not create new files unless necessary."
- Same docs. For multi-session coding, plan the files up front. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "set up memory files deliberately instead of writing them ad hoc as work progresses"
- Same docs. A session-end update is part of the pattern. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "Before a session ends, it updates the progress log with what was completed and what remains."
- Same docs. Do not record a claim as done. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "Mark a feature complete only after end-to-end verification confirms it works, not when the code is written."
- VR (GitHub, Jan 2026). Writing is a tool the agent calls. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "We implemented memory creation as a tool that agents can invoke when they discover something that’s likely to have actionable implications for future tasks."
- Same post. Each memory carries its evidence. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "we store memories with citations: references to specific code locations that support each fact"
- Same post. Measured in production with an A/B test. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "We ran A/B tests on the first two Copilot agents to deploy memory" "7% increase in pull request merge rates (90% with memories vs. 83% without)"
- Same post. The second measure moved less. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "2% increase in positive feedback on comments (77% with memories vs 75% without)"
- PP (MemGPT). Another trigger: write when the context is nearly full. [OPENED https://arxiv.org/pdf/2310.08560] "to allow the LLM to use MemGPT functions to store important information contained in the FIFO queue" "(e.g. 70% of the context window)"
- VR (Anthropic harness post, Nov 2025). Format matters for state files. [OPENED https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents] "the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files"

**Sleep-time and background consolidation.**

- PP (sleep-time compute). Offline thinking pays when the next question is predictable. [OPENED https://arxiv.org/abs/2504.13171] "finding the predictability of the user query to be well correlated with the efficacy of sleep-time compute"
- Who proposed it, per Anthropic. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Researchers at Letta and UC Berkeley proposed sleep-time compute"
- VR (Letta blog). Their reason to move memory edits out of the main agent. [OPENED https://www.letta.com/blog/sleep-time-compute] "Memory formation in MemGPT is incremental, so memories may become messy and disorganized over time."
- VR (LangChain, Oct 2024). Writing during the turn adds delay. [OPENED https://blog.langchain.com/memory-for-agents/] "has the downside of introducing some extra latency before any response is delivered"
- Same post. Writing in the background has its own cost. [OPENED https://blog.langchain.com/memory-for-agents/] "the memory is not updated immediately, and extra logic is needed determine when to kick off the background process"
- VR (Anthropic, Nov 2026). Background review fixed a wrong note by checking the transcript. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Claude checked the note against the session transcript, caught its error, and rewrote it."
- Same post. Both timings have a cost. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "logging notes in the moment inevitably draws Claude’s attention away from its main task"
- Same post. Background output arrives late. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "any outputs from dreaming may not be immediately accessible to Claude"
- Same post. Derived stores can bloat. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "the wiki grew larger than the documents themselves"
- Security note. Session-end summarization is itself an injection point. See §9, Unit 42.

**Design rule.**

- Let the agent write notes when it judges something worth keeping. Tell it in one sentence what memory is for. Do not hard-code "record only X".
- Do not run an extraction pass on every turn. I found no evidence that it helps a coding agent, and clear evidence that such pipelines omit and invent.
- Store only what the repository cannot tell the agent: decisions, reasons, user corrections, tested rules, open work.
- Every note carries where it came from and whether it was checked.
- Update a small state file at the end of a session. Mark work done only after a check passed.
- Treat background consolidation as optional. It must compare notes to transcripts or files, and it must not be the only writer.
- Keep machine state in a structured format. Keep narrative in prose.

---

## 4. Deduplication, conflict resolution, decay and forgetting

**Finding.** Changed facts are where memory systems fail. Replacing or invalidating the old value at write time works better than leaving both for retrieval to sort out. Mark old facts invalid rather than deleting them. Time-based decay has little direct evidence behind it. For facts about a moving codebase, checking at read time is the approach with measured results.

**Evidence that updates are the weak point.**

- PP (MemoryAgentBench). No tested method could chain two updated facts. [OPENED https://arxiv.org/html/2507.05257v3] "We observe that all methods fail on the multi-hop situation (with achieving at most 7% accuracy)."
- PP (MERIT, Jul 2026). Similarity search returns old and new together. [OPENED https://arxiv.org/pdf/2609.05441] "retrieval surfaces stale and fresh values side by side with no recency signal, while update-on-write overwrites"
- Its limit. The tasks are synthetic. [OPENED https://arxiv.org/pdf/2609.05441] "three synthetic domains with scripted users"
- Same paper. Stale memory causes wrong actions, not just missing ones. [OPENED https://arxiv.org/pdf/2609.05441] "it produces a confidently wrong action"
- Same paper. Adding retrieval back to a clean fact store brought the stale values back. [OPENED https://arxiv.org/pdf/2609.05441] "the retrieval half re-imports the staleness the fact store had eliminated"
- Same paper, abstract. Having the right value in context is not enough. [OPENED https://arxiv.org/abs/2609.05441] "agents act on a correctly retrieved value only 55% of the time"
- PR (ICLR 2025). Designs without time stamps do badly on time questions. [OPENED https://arxiv.org/pdf/2410.10813] "Naive time-agnostic memory designs perform poorly on temporal reasoning questions."
- VR docs (Claude Code). Two conflicting instructions give an unpredictable result. [OPENED https://code.claude.com/docs/en/memory.md] "if two instructions contradict each other, Claude may pick one arbitrarily"

**Temporal validity and invalidation: Zep and Graphiti.** (PP written by the vendor, plus the project README.)

- Two timelines, four time stamps. [OPENED https://arxiv.org/pdf/2501.13956] "the system tracks four timestamps"
- New information wins. [OPENED https://arxiv.org/pdf/2501.13956] "Graphiti consistently prioritizes new information when determining edge invalidation"
- History is kept. [OPENED https://arxiv.org/pdf/2501.13956] "maintaining both current relationship states and historical records of relationship evolution over time"
- Supersession, not deletion. [OPENED https://raw.githubusercontent.com/getzep/graphiti/main/README.md] "When information changes, old facts are invalidated — not deleted."
- Provenance on every fact. [OPENED https://raw.githubusercontent.com/getzep/graphiti/main/README.md] "Every entity and relationship traces back to the episodes (raw data) that produced it."
- VR docs (Zep). A worked example. [OPENED https://help.getzep.com/facts] "Zep attempts to invalidate the fact that Kendra loves Adidas shoes and creates two new facts"
- PP (mem0, graph variant). The same choice. [OPENED https://arxiv.org/pdf/2504.19413] "marking them as invalid rather than physically removing them to enable temporal reasoning"
- Caution. In Zep's own LongMemEval run, one question type got worse with the graph than with full context. [OPENED https://arxiv.org/pdf/2501.13956] "represents a notable exception to Zep’s otherwise consistent improvements"

**Decay and forgetting: MemoryBank.** (PP. I could not confirm a venue on the pages I opened.)

- The mechanism. Recall strengthens a memory and resets its clock. [OPENED https://arxiv.org/pdf/2305.10250] "We increase S by 1 and reset t to 0, hence forget it with a lower probability."
- The authors' own caveat. [OPENED https://arxiv.org/pdf/2305.10250] "this is an exploratory and highly simplified memory updating model"
- The test was small. [OPENED https://arxiv.org/pdf/2305.10250] "a memory storage of 10 days of conversations involving 15 virtual users"
- What I checked in the text I opened: the word "forget" does not appear in the experiments section. The paper reports no result that isolates the forgetting step. Treat decay as an idea, not a finding.
- PR (UIST 2023). Generative Agents use decay to rank memories for retrieval. The paper does not describe deleting them. [OPENED https://arxiv.org/pdf/2304.03442] "we treat recency as an exponential decay function"
- VR docs (Anthropic memory tool). Advice, given without data. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "Periodically delete memory files that haven’t been accessed in a long time."

**Staleness of facts about a changing system.**

- VR (GitHub, Jan 2026). Their framing of the core problem. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "ensuring that any stored knowledge remains valid as code evolves across branches and time"
- They rejected a background curation service. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "such an approach would introduce significant engineering complexity and LLM costs"
- They check at read time instead. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "Before applying any memory, the agent is prompted to verify its accuracy and relevance by checking the cited code locations."
- A failed check triggers a correction. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "the agent is encouraged to store a corrected version of the memory reflecting the new evidence"
- A passed check refreshes the date. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "the agent is encouraged to store it again in order to refresh its timestamp"
- They stress-tested with planted wrong memories. This is the vendor's own test. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "agents consistently verified citations, discovered contradictions, and updated incorrect memories"
- And with noise from dead branches. [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "we overrepresented memories from branches that were abandoned or closed without merging"
- VR (Anthropic, Nov 2026). Memory drifts. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "Memory can also drift and become irrelevant as the environment changes."
- Same post. Spend checking effort where change is likely. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "It may be important instead to focus dreaming on information that’s likely to change"
- VR docs (Claude Code). The harness stamps each memory file. [OPENED https://code.claude.com/docs/en/memory.md] "The timestamp shows how current the fact is"
- Same docs. The index is pruned by hand, by the model. [OPENED https://code.claude.com/docs/en/memory.md] "keep one line per entry, move detail into topic files, and merge or drop stale entries"

**Duplicates and concurrent writers.**

- VR docs (mem0). Storing raw text skips the merge step. [OPENED https://docs.mem0.ai/core-concepts/memory-operations/add] "Mem0 stores your payload exactly as provided, so duplicates can land"
- VR (Anthropic, Nov 2026). Several agents writing one page lost facts. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "agents had overwritten one another’s work" "41 of 57 facts survived"

**Design rule.**

- One fact, one place. When it changes, replace it. Move the old value to a dated "superseded" record.
- Never leave two live versions of a fact for search to find.
- Stamp every note with a date and a source pointer.
- Treat a note about anything outside the note itself as a claim. Re-check the pointer before acting on it.
- Prefer a cheap check at read time over a background curation service.
- Do not build a decay formula. Prune by "last verified" date, in the open, with a log.
- Guard against two writers on one file.

---

## 5. Transcript summarization loss

**Finding.** Summaries drop specifics. Memory that kept the raw record searchable beat summary-only memory in the four recall tests I opened. One test of changed facts went the other way, because a rewritten summary carries only the newest value. Fixed sections keep more than free prose. Summaries can also hide the signs of failure. Direct evidence on repeated summarization is thin: one vendor comparison.

**Summary-only memory versus searchable history.**

- PP (MemGPT). The baseline saw only a summary. [OPENED https://arxiv.org/pdf/2310.08560] "The baselines are able to see a lossy summarization of the past five conversations to mimic an extended recursive summarization procedure"
- Same paper. The gap was large. [OPENED https://arxiv.org/pdf/2310.08560] "there is a clear drop in both accuracy and ROUGE scores when going from MemGPT to the corresponding LLM baselines"
- PP (Zep, citing that table). The summary baseline scored 35.3% against 93.4% for searchable history. [OPENED https://arxiv.org/pdf/2501.13956] "currently leads performance metrics with 93.4% accuracy using gpt-4-turbo" "a significant improvement over the 35.3% baseline achieved through recursive summarization"
- Same paper, own rerun on the same test. [OPENED https://arxiv.org/pdf/2501.13956] "the full-conversation baseline achieved 94.4% accuracy, slightly surpassing MemGPT’s reported results, while the session summary baseline achieved 78.6%"
- PR (ACL 2024). Session summaries were retrieved well and still did not help. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "using session summaries as context does not significantly improve the performance"
- Same paper. The stated cause. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "likely due to loss of information during the conversion of dialogs to summaries"
- PR (ICLR 2025). Storing extracted facts instead of the turns hurt. [OPENED https://arxiv.org/pdf/2410.10813] "replacing sessions or rounds with extracted summaries or facts negatively impacts QA performance due to information loss"
- Same paper. The best unit to store was the single exchange. [OPENED https://arxiv.org/pdf/2410.10813] "round is the more optimal granularity for storing and utilizing the interactive history"
- Same paper. Rewriting stored memory drops facts. [OPENED https://arxiv.org/pdf/2410.10813] "ChatGPT often modify this information when it compresses the history, resulting in information loss"

**Compaction failure modes.**

- VR docs (Claude Code). Early instructions go first. [OPENED https://code.claude.com/docs/en/how-claude-code-works.md] "detailed instructions from early in the conversation may be lost"
- VR (Anthropic, Nov 2025). Compaction alone did not carry a long build. [OPENED https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents] "compaction isn’t sufficient"
- Same post. The hand-off was unclear. [OPENED https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents] "doesn’t always pass perfectly clear instructions to the next agent"
- VR (Anthropic, Mar 2026). Compaction keeps the same agent going, with its habits. [OPENED https://www.anthropic.com/research/harness-design-long-running-apps] "While compaction preserves continuity, it doesn't give the agent a clean slate"
- VR (Anthropic postmortem, Apr 2026). A bug dropped earlier reasoning each turn. Users saw forgetting and repetition. [OPENED https://www.anthropic.com/research/april-23-postmortem] "Claude would continue executing, but increasingly without memory of why it had chosen to do what it was doing."
- Workshop paper (DL4C at NeurIPS 2025, per the arXiv comment line; authors at JetBrains Research; SWE-bench Verified). Hiding old tool output did as well as summarizing, for less. [OPENED https://arxiv.org/abs/2508.21433] "a simple environment observation masking strategy halves cost relative to the raw agent while matching, and sometimes slightly exceeding, the solve rate of LLM summarization"
- Same paper, body. Summaries made agents run longer. [OPENED https://arxiv.org/pdf/2508.21433] "JetBrains Research" "suggesting they mask failure signals that would otherwise prompt earlier termination"
- Same paper. [OPENED https://arxiv.org/pdf/2508.21433] "context summaries act as a reinforcing signal, encouraging the agent to keep going"
- PO (Drew Breunig, Jun 2025). An error that enters a summary keeps coming back. [OPENED https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html] "Context Poisoning is when a hallucination or other error makes it into the context, where it is repeatedly referenced."
- PO (Manus, Jul 2025). [OPENED https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus] "any irreversible compression carries risk"
- PO (Cognition, Jun 2025). On compressing history into key decisions. [OPENED https://cognition.ai/blog/dont-build-multi-agents] "This is hard to get right."

**Summaries of summaries.**

- VR (Factory, Dec 2025; the vendor graded its own method against two rivals with an LLM judge). Two update styles. [OPENED https://factory.ai/news/evaluating-compression] "Anthropic regenerates the full summary on each compression, while Factory's anchored approach incrementally merges new information into a persistent summary"
- The measured gap was modest, on a 0–5 scale. [OPENED https://factory.ai/news/evaluating-compression] "Factory scores 0.35 points higher than OpenAI and 0.26 higher than Anthropic overall."
- Their explanation. [OPENED https://factory.ai/news/evaluating-compression] "structure forces preservation"
- Fixed sections act as a checklist. [OPENED https://factory.ai/news/evaluating-compression] "Each section acts as a checklist: the summarizer must populate it or explicitly leave it empty."
- Every method lost track of files touched. [OPENED https://factory.ai/news/evaluating-compression] "Artifact trail is the weakest dimension for all methods, ranging from 2.19 to 2.45."
- The judge was blinded. [OPENED https://factory.ai/news/evaluating-compression] "The judge does not know which compression method produced the response."
- Counter-evidence. A journal paper (Neurocomputing, per the arXiv comment line) found recursive summaries helped chat consistency. [OPENED https://arxiv.org/abs/2308.15022] "our method can generate more consistent responses in a long-context conversation"
- Counter-evidence. In MERIT, a rewritten summary handled changed facts well. [OPENED https://arxiv.org/abs/2609.05441] "update-on-write stores (a structured fact store and, notably, LLM summarization) remain at 0.70-1.00"

**What to preserve verbatim.**

- VR (Anthropic, Nov 2026). Quoting beat summarizing. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "quoted the terms word for word rather than summarizing them into a shared table" "57 of 57 facts survived"
- Same post. The summarizing version lost facts. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "the shared table summarized the contract terms poorly and was missing some of them altogether"
- Same post. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "100% of the criteria could be met, up from 72%"
- VR (Anthropic, Sep 2025). What Claude Code's own compaction tries to keep. [OPENED https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents] "The model preserves architectural decisions, unresolved bugs, and implementation details while discarding redundant tool outputs or messages."
- VR (Factory). The details that went missing first were exact ones. [OPENED https://factory.ai/news/evaluating-compression] "A wrong file path or misremembered function name leads to failed edits or hallucinated solutions."
- PO (Manus). Drop the bulk, keep the handle. [OPENED https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus] "the content of a web page can be dropped from the context as long as the URL is preserved"
- PO (Manus). Keep failures visible. [OPENED https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus] "Erasing failure removes evidence."

**What survives compaction in the harness.**

- VR docs (Claude Code). Files on disk outlive the summary. [OPENED https://code.claude.com/docs/en/memory.md] "Project-root CLAUDE.md survives compaction"
- VR docs (Anthropic memory tool). [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "memory preserves the information that must survive summarization"
- VR docs (Claude Code hooks). A hook can steer what the summary keeps. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code uses its stdout as instructions for the compaction summary"
- VR docs (Anthropic platform). Recent turns can be kept word for word. [OPENED https://platform.claude.com/docs/en/build-with-claude/compaction.md] "when the last few turns must reach Claude word for word"
- VR docs (Anthropic prompting guide). A fresh start from files can beat compaction. [OPENED https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips.md] "consider starting with a brand new context window rather than using compaction"
- VR (Anthropic, Mar 2026). Scaffolding ages. A newer model no longer needed the reset trick. [OPENED https://www.anthropic.com/research/harness-design-long-running-apps] "I was able to drop context resets from this harness entirely"

**Design rule.**

- A summary is never the only copy. Keep the source and point to it.
- Use fixed sections: goal, decisions with reasons, files touched, open items, next step. Each must be filled or marked empty.
- Copy paths, commands, error text, identifiers and the user's own constraints word for word.
- Do not summarize a summary. Merge new facts into a standing state file.
- Write what must last to a file before compaction runs.
- Record failures as well as successes.

---

## 6. Benchmarks and their limits

**Finding.** The best-known memory benchmarks test question answering over chat logs. Three of them fit inside a current context window. Vendor scores on them disagree by tens of points. Newer benchmarks test whether memory changes what an agent does. None I found tests a file-based project memory for a coding agent.

**LoCoMo.** (PR, ACL 2024.)

- Size, as published at ACL. [OPENED https://aclanthology.org/2024.acl-long.747/] "each encompassing 600 turns and 16K tokens on avg., over up to 32 sessions"
- The first arXiv abstract gave smaller numbers. [OPENED https://arxiv.org/abs/2402.17753] "each encompassing 300 turns and 9K tokens on avg."
- The public release is small. [OPENED https://raw.githubusercontent.com/snap-research/locomo/main/README.MD] "The benchmark consists of ten conversations."
- Headline at the time. Best model 51.6 against a human 87.9. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "an overall score of 51.6" "it notably lags behind the human benchmark of 87.9"
- The first release was larger. [OPENED https://raw.githubusercontent.com/snap-research/locomo/main/README.MD] "The initial release contained 50 conversations."
- Long context raised wrong answers on trick questions. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "LLMs can be easily misled into generating hallucinations when they are subjected to long contexts"

**LongMemEval.** (PR, ICLR 2025.)

- The five abilities. [OPENED https://arxiv.org/abs/2410.10813] "information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention"
- Size. [OPENED https://arxiv.org/abs/2410.10813] "With 500 meticulously curated questions"
- Two standard settings. [OPENED https://arxiv.org/pdf/2410.10813] "with approximately 115k tokens per problem" "with 500 sessions (around 1.5 million tokens)"
- Headline one. [OPENED https://arxiv.org/abs/2410.10813] "commercial chat assistants and long-context LLMs showing a 30% accuracy drop on memorizing information across sustained interactions"
- Headline two. Reading everything was far worse than reading only the evidence. [OPENED https://arxiv.org/pdf/2410.10813] "these LLMs showed a 30% to 60% performance decline when tasked with reading the entire"
- Design findings: store single exchanges, add extracted facts to the search key, index time stamps (see §2 and §5).
- Even perfect retrieval is not enough. [OPENED https://arxiv.org/pdf/2410.10813] "Even with perfect memory recall, accurately utilizing retrieved items is non-trivial."
- Grading is by LLM judge. [OPENED https://arxiv.org/pdf/2410.10813] "the evaluator achieves more than 97% agreement with human experts"
- The data set was revised in 2025. [OPENED https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/raw/main/README.md] "this version removes noisy history sessions that interfere with the answer correctness"

**DMR (Deep Memory Retrieval).** (Introduced in the MemGPT preprint.)

- What it is. [OPENED https://arxiv.org/pdf/2310.08560] "We introduce a new ‘deep memory retrieval’ (DMR) task"
- It is tiny. [OPENED https://arxiv.org/pdf/2501.13956] "each conversation contains only 60 messages, easily fitting within current LLM context windows"
- It tests one thing. [OPENED https://arxiv.org/pdf/2501.13956] "The evaluation relies exclusively on single-turn, fact-retrieval questions"

**Criticism one: the data fits in context.**

- PP (mem0's own paper). Full context beat the memory system on LoCoMo. [OPENED https://arxiv.org/pdf/2504.19413] "a full-context method that ingests a chunk of roughly 26,000 tokens still achieves the highest J score (approximately 73%)"
- VR (Zep blog, May 2025, updated Jun 2026). [OPENED https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/] "this is easily within the context window capabilities of modern LLMs"
- PP (Zep's paper, on LongMemEval-S). [OPENED https://arxiv.org/pdf/2501.13956] "This length, while substantial, remains within the context windows of current frontier models"
- VR (Penfield, on LongMemEval-S). [OPENED https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg] "it is a context window test, not a memory test"
- Penfield is itself a memory vendor. [OPENED https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg] "We give AI agents the same gift: persistent recall, connected knowledge, and permanent continuity."
- VR (Letta). Their conclusion from the filesystem result. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "current memory benchmarks may not be very meaningful"

**Criticism two: LoCoMo's answer key and judge.** (Self-published audit repository with scripts. The write-up is by a memory vendor. Not peer-reviewed. I did not rerun it.)

- Wrong answers in the key. [OPENED https://raw.githubusercontent.com/dial481/locomo-audit/main/README.md] "99 of 1,540 questions (6.4%) have wrong golden answers. Theoretical scoring ceiling is 93.57%."
- A lenient judge. [OPENED https://raw.githubusercontent.com/dial481/locomo-audit/main/README.md] "62.81% of intentionally wrong vague-but-topical answers accepted by the LLM judge"
- Small categories. [OPENED https://raw.githubusercontent.com/dial481/locomo-audit/main/README.md] "Open-domain (n=96) requires a 15+ point gap to distinguish any two systems."
- The prompt moved the score more than the memory did. [OPENED https://raw.githubusercontent.com/dial481/locomo-audit/main/README.md] "The answer prompt, not the memory system, explains the score."
- The "does it know what it does not know" questions go unscored. [OPENED https://raw.githubusercontent.com/dial481/locomo-audit/main/README.md] "no published LoCoMo result evaluates them"
- Zep lists similar data problems. [OPENED https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/] "Category 5 was unusable due to missing ground truth answers"

**Criticism three: vendor score disputes.**

- Mem0's paper scored Zep at 65.99%. Zep disputes it. [OPENED https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/] "This starkly contrasts with the 65.99% score reported for Zep in the Mem0 paper"
- Zep first claimed a higher score, then corrected itself to 75.14%. [OPENED https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/] "we erred in how we calculated Zep's LoCoMo score" "Zep's corrected result is 75.14% +/- 0.17"
- A Mem0 author says the right figure is 58.44%, not Zep's first claim of 84%. (GitHub issue, read through WebFetch, which returns a model-written extract. Quotes are as that extract gave them. The extract names the author as GitHub user deshraj.) [OPENED https://github.com/getzep/zep-papers/issues/5] "our analysis shows that Zep achieves 58.44 % accuracy—not the 84 % reported."
- Zep's reply in the same issue. [OPENED https://github.com/getzep/zep-papers/issues/5] "We're struggling to see how you got to a revised 58.44%."
- Letta says Mem0's MemGPT number cannot be explained. [OPENED https://www.letta.com/blog/benchmarking-ai-agent-memory] "Mem0 did not respond to requests for clarification on how the benchmarking numbers were computed"
- Mem0 reports two scores for itself. [OPENED https://mem0.ai/library/agent-memory/how-to-read-memory-benchmarks] "Our LoCoMo scores have been reported at both 74% and 92.5%, and neither is wrong"
- Mem0's own warning. [OPENED https://mem0.ai/library/agent-memory/how-to-read-memory-benchmarks] "Change any of those and a memory score can move by twenty points."
- The audit reports a failed third-party rerun of another system. [OPENED https://raw.githubusercontent.com/dial481/locomo-audit/main/README.md] "Third parties report 38.38% vs. claimed 92.32%"

**Newer benchmarks, 2025–2026.** (All preprints unless noted.)

- LongMemEval-V2 (May 2026). Memory of an environment, for web agents. [OPENED https://arxiv.org/abs/2605.12493] "451 manually curated questions covering five core memory abilities for web agents"
- Its five abilities. [OPENED https://arxiv.org/abs/2605.12493] "static state recall, dynamic state tracking, workflow knowledge, environment gotchas, and premise awareness"
- Its scale. [OPENED https://arxiv.org/abs/2605.12493] "containing up to 500 trajectories and 115M tokens"
- MemoryAgentBench (Jul 2025; a search extract says ICLR 2026, which I did not confirm). Four skills. [OPENED https://arxiv.org/abs/2507.05257] "accurate retrieval, test-time learning, long-range understanding, and selective forgetting"
- Its verdict. [OPENED https://arxiv.org/abs/2507.05257] "current methods fall short of mastering all four competencies"
- BEAM (Oct 2025). Scale. [OPENED https://arxiv.org/abs/2510.27246] "100 conversations and 2,000 validated questions"
- HaluMem (Nov 2025). Errors by stage. [OPENED https://arxiv.org/abs/2511.03506] "the first operation level hallucination evaluation benchmark tailored to memory systems"
- MERIT (Jul 2026). Does memory change what a tool-using agent does, and at what cost. [OPENED https://arxiv.org/abs/2609.05441] "measures the marginal utility of memory for task-executing agents under explicit cost accounting"
- Its critique of the older tests. [OPENED https://arxiv.org/abs/2609.05441] "not whether remembered facts change what a tool-using agent does"
- Its headline. The implementation matters more than the idea. [OPENED https://arxiv.org/abs/2609.05441] "Swapping a memory's implementation moves task success by up to 60 points"
- CL-Bench 1.0, as described by Anthropic. I did not open the benchmark itself. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "a benchmark that measures an agent’s ability to use memory in order to tackle long-horizon tasks"
- Context-Bench (VR, Letta). File operations over long tasks. [OPENED https://www.letta.com/blog/context-bench] "evaluates how well language models can chain file operations, trace entity relationships, and manage multi-step information retrieval in long-horizon tasks"
- The closest study to a coding-agent project memory is the AGENTS.md evaluation in §1. It tests static context files, not a memory that grows.

**Design rule.**

- Do not cite LoCoMo, DMR or LongMemEval-S scores as proof that a memory design works.
- Any test of your own needs two baselines: no memory, and everything in context.
- Report the number of tasks and an interval with every score.
- Test whether memory changes actions and outcomes, not only whether a fact can be recalled.
- Include changed facts and "the answer is not in memory" cases. These are the cases public scores skip.

---

## 7. Evaluation method for memory features

**Finding.** Retrieval scores are useful and insufficient. The decisive test is the same tasks run with and without the feature, several times, graded on outcomes. LLM judges are biased in known ways. Small samples only detect large effects. People's own impressions can be wrong in sign.

**Offline gold sets and retrieval metrics.**

- PR (ICLR 2025). Label where the answer lives, then score what was retrieved. [OPENED https://arxiv.org/pdf/2410.10813] "We report Recall@k and NDCG@k, where k is the number of top items retrieved by the system."
- VR (Anthropic, Sep 2024). A miss-rate form of recall. [OPENED https://www.anthropic.com/news/contextual-retrieval] "We use 1 minus recall@20 as our evaluation metric"
- STD (scikit-learn docs). nDCG rewards putting the right items first, on a 0-to-1 scale. [OPENED https://scikit-learn.org/stable/modules/generated/sklearn.metrics.ndcg_score.html] "Then divide by the best possible score (Ideal DCG, obtained for a perfect ranking) to obtain a score between 0 and 1."
- Reference (Wikipedia). Precision at k counts relevant items in the top k and ignores their order. [OPENED https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)] "corresponds to the number of relevant results among the top 10 retrieved documents" "fails to take into account the positions"
- Limit one. Good retrieval did not mean good answers. [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "using session summaries as context does not significantly improve the performance despite high recall accuracies"
- Limit two. A retrieved fact was acted on about half the time. [OPENED https://arxiv.org/abs/2609.05441] "agents act on a correctly retrieved value only 55% of the time"

**End-to-end task success.** (VR. Anthropic, "Demystifying evals for AI agents", 9 Jan 2026.)

- Grade the end state, not the claim. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "The outcome is the final state in the environment at the end of the trial."
- Grade results, not steps. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "it’s often better to grade what the agent produced, not the path it took"
- Prefer code checks. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "We recommend choosing deterministic graders where possible, LLM graders where necessary or for additional flexibility"
- Repeat runs. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "Because model outputs vary between runs, we run multiple trials to produce more consistent results."
- Start small. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "20-50 simple tasks drawn from real failures is a great start"
- Why small can work early. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "this large effect size means small sample sizes suffice"
- Test both directions. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "Test both the cases where a behavior should occur and where it shouldn't."
- Isolate trials. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "Each trial should be “isolated” by starting from a clean environment."
- Leaks between trials are real. This matters for any no-memory baseline. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "Claude gaining an unfair advantage on some tasks by examining the git history from previous trials"
- Consistency metric. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "pass^k measures the probability that all k trials succeed"
- Read the transcripts. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "we do not take eval scores at face value until someone digs into the details of the eval and reads some transcripts"

**LLM-as-judge pitfalls.**

- PR (NeurIPS 2023 Datasets and Benchmarks, per the arXiv comment line). The three named biases. [OPENED https://arxiv.org/abs/2306.05685] "including position, verbosity, and self-enhancement biases, as well as limited reasoning ability"
- Same paper. Judges can still track people well. [OPENED https://arxiv.org/abs/2306.05685] "achieving over 80% agreement, the same level of agreement between humans"
- PO (Eugene Yan, summarizing that paper). Verbosity. [OPENED https://eugeneyan.com/writing/llm-evaluators/] "Both claude-v1 and gpt-3.5 preferred the longer response more than 90% of the time"
- PP. Position. Order alone can flip a ranking. [OPENED https://arxiv.org/abs/2305.17926] "can be easily hacked by simply altering their order of appearance in the context"
- Same paper. How far. [OPENED https://arxiv.org/abs/2305.17926] "Vicuna-13B could beat ChatGPT on 66 over 80 tested queries with ChatGPT as an evaluator"
- PP. Self-preference. [OPENED https://arxiv.org/abs/2404.13076] "an LLM evaluator scores its own outputs higher than others' while human annotators consider them of equal quality"
- PP. A catalogue of twelve. [OPENED https://arxiv.org/abs/2410.02736] "we identify 12 key potential biases"
- VR (Anthropic, Mar 2026). Agents flatter their own work. [OPENED https://www.anthropic.com/research/harness-design-long-running-apps] "agents reliably skew positive when grading their own work"
- Same post. A separate judge is still lenient. [OPENED https://www.anthropic.com/research/harness-design-long-running-apps] "the evaluator is still an LLM that is inclined to be generous towards LLM-generated outputs"
- Leniency in a memory benchmark. See §6: the LoCoMo judge accepted most vague wrong answers.
- VR (Anthropic evals post). Calibrate. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "LLM-as-judge graders should be closely calibrated with human experts"
- Same post. Give the judge a way to say it cannot tell. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "providing an instruction to return “Unknown” when it doesn’t have enough information"
- Same post. One judge per criterion. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "grade each dimension with an isolated LLM-as-judge rather than using one to grade all dimensions"
- PO (Hamel Husain). Avoid 1–5 scales. [OPENED https://hamel.dev/blog/posts/llm-judge/] "Tracking a bunch of scores on a 1-5 scale is often a sign of a bad eval process"
- Same post. Report both error types. [OPENED https://hamel.dev/blog/posts/llm-judge/] "report the judge’s True Positive Rate and True Negative Rate separately"
- PO (Eugene Yan). [OPENED https://eugeneyan.com/writing/llm-evaluators/] "where possible, I have my evaluators return binary outputs"

**Blinded pairwise comparison and randomization.**

- VR (Anthropic's skill-creator skill, comparator instructions). [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/agents/comparator.md] "You receive two outputs labeled A and B, but you do NOT know which skill produced which."
- Same skill, main file. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md] "give two outputs to an independent agent without telling it which is which"
- PP. The fix for position bias is to run both orders. [OPENED https://arxiv.org/abs/2305.17926] "Balanced Position Calibration, which aggregates results across various orders to determine the final score"
- PO (Eugene Yan). Pairwise suits subjective quality. [OPENED https://eugeneyan.com/writing/llm-evaluators/] "Pairwise comparison chooses the better of two responses or declares a tie."
- Inference: blinding hides the label, not the style. If one arm writes longer answers, a judge can still tell them apart, and verbosity bias then favours that arm. Strip or equalize length-revealing features, or grade outcomes instead.

**Ablation: with and without the feature.**

- VR (skill-creator). Run both arms together. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md] "For each test case, spawn two subagents in the same turn — one with the skill, one without."
- VR docs (Anthropic Skills best practices). Evals come first. [OPENED https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md] "Create evaluations BEFORE writing extensive documentation."
- Same docs. The baseline. [OPENED https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md] "Measure Claude’s performance without the Skill."
- Same docs. Every model you ship on. [OPENED https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md] "Test your Skill with all the models you plan to use it with."
- VR (skill-creator). Find checks that cannot fail. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md] "assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky)"
- VR (skill-creator, grader instructions). [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/agents/grader.md] "A passing grade on a weak assertion is worse than useless — it creates false confidence."
- Same file. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/agents/grader.md] "The burden of proof to pass is on the expectation."
- VR (skill-creator). Hold out a test set. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md] "selected by test score rather than train score to avoid overfitting"
- VR (skill-creator). Trigger tests need hard negatives. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md] "the most valuable ones are the near-misses"
- VR (Anthropic postmortem, Apr 2026). Ablate line by line. [OPENED https://www.anthropic.com/research/april-23-postmortem] "removing lines from the system prompt to understand the impact of each line"
- Same post. A narrow suite missed a real regression. [OPENED https://www.anthropic.com/research/april-23-postmortem] "no regressions in the set of evaluations we ran"
- PR (UIST 2023). A classic component ablation. [OPENED https://arxiv.org/pdf/2304.03442] "Performance degraded with the removal of each component in the ablation conditions"
- VR (Anthropic, Nov 2026). Memory against a stateless baseline, per model. [OPENED https://www.anthropic.com/research/components-of-agent-memory] "comparing memory with a stateless baseline across models"

**Counterfactual and no-memory baselines.**

- PP (MERIT). Prove the task cannot be solved without memory. [OPENED https://arxiv.org/pdf/2609.05441] "The leak check asserts at generation time that every gold fact value is absent from the probe episode’s inputs"
- Same paper. A success can come from leftover state. [OPENED https://arxiv.org/pdf/2609.05441] "probes then “succeeded” off inherited world state"
- Same paper, abstract. With leaks closed, the floor was zero. [OPENED https://arxiv.org/abs/2609.05441] "memory lifts dependent-task success from a leak-verified floor of 0.00 to 0.55-1.00"
- Same paper. Replaying everything is the other baseline, and it costs too much. [OPENED https://arxiv.org/abs/2609.05441] "full replay is never economical"
- VR (GitHub). A production A/B test is the strongest form. See §3: 90% against 83% merge rate.
- VR (Cursor). [OPENED https://cursor.com/blog/semsearch] "We ran an A/B test where both groups used the same model"

**Sample size and variance.**

- VR (Anthropic research blog, Nov 2024, summarizing a preprint). Report error bars. [OPENED https://www.anthropic.com/research/statistical-approach-to-model-evals] "we encourage researchers to report the SEM, derived from the Central Limit Theorem, alongside each calculated eval score"
- Related questions are not independent. [OPENED https://www.anthropic.com/research/statistical-approach-to-model-evals] "clustered standard errors on popular evals can be over three times as large as naive standard errors"
- Compare on the same questions. [OPENED https://www.anthropic.com/research/statistical-approach-to-model-evals] "conducting a paired-differences test lets us eliminate the variance in question difficulty and focus on the variance in responses"
- Small sets hide small effects. [OPENED https://www.anthropic.com/research/statistical-approach-to-model-evals] "If an eval doesn’t have very many questions, confidence intervals associated with any statistical tests will tend to be wide."
- Resample. [OPENED https://www.anthropic.com/research/statistical-approach-to-model-evals] "we recommend resampling answers from the same model several times"
- PP (the paper behind that post). [OPENED https://arxiv.org/abs/2411.00640] "evaluations are experiments"
- VR (Anthropic, Feb 2026). The test rig adds noise. [OPENED https://www.anthropic.com/research/infrastructure-noise] "infrastructure configuration alone can produce differences that exceed those margins"
- Same post. A working threshold. [OPENED https://www.anthropic.com/research/infrastructure-noise] "leaderboard differences below 3 percentage points deserve skepticism until the eval configuration is documented and matched"
- PP (MERIT). Seeds alone moved one method a long way. [OPENED https://arxiv.org/abs/2609.05441] "max seed gap 0.45"
- Sample sizes behind claims in this digest: 65 students (§8), 18 participants (§8), 21 programmers (§8), 27 users (§8), 16 developers (below), 25 and 24 questions (§2), 10 conversations (§6).

**Self-report versus measurement.**

- Research-organization report (METR, Jul 2025; a randomized trial). [OPENED https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/] "they take 19% longer than without"
- Its size. [OPENED https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/] "we recruited 16 experienced developers from large open-source repositories" "(246 total)"
- The developers believed the opposite. [OPENED https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/] "developers expected AI to speed them up by 24%, and even after experiencing the slowdown, they still believed AI had sped them up by 20%"
- The design to copy. [OPENED https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/] "we randomly assign each issue to either allow or disallow use of AI while working on the issue"
- PR (AAAI 2024, per the arXiv comment line). Acceptance rate is a trap as a target. [OPENED https://arxiv.org/abs/2306.04930] "using suggestion acceptance as a reward signal for guiding the display of suggestions can lead to suggestions of reduced quality"

**Cost belongs in the result.**

- PP (AGENTS.md study). A feature can cost more and help nothing. [OPENED https://arxiv.org/pdf/2602.11988] "leading to a significant (p-value < 0.001%) cost increase of 20% and 23% on average"
- VR (Factory). [OPENED https://factory.ai/news/evaluating-compression] "What matters is total tokens to complete a task, not tokens per request."

**Design rule.**

- Build a small gold set first: questions, the note that answers each, and the expected action.
- Score retrieval with recall@k and nDCG@k. Then score the task outcome. Never report the first without the second.
- Run every task with the feature and without it, in the same session batch, at least three times each.
- Verify the no-memory arm really has no memory. Check for leaks through files, git history and caches.
- Grade with code where you can. Where you need a judge: pass/fail criteria, blind labels, both orders, a different model family if possible, and a human-labelled sample to check it.
- Report n, the paired difference, and an interval. Call any gap under a few points "no difference shown".
- Record tokens and time per task in both arms.
- Do not use "the user accepted it" or "it felt faster" as the success measure.

---

## 8. Proactive agents and attention

**Finding.** Unasked help can raise output. It also interrupts. The two studies of proactive coding assistants agree on the lever: how often, and when. Help offered at a natural stopping point is used. Help offered often is resented, even when it works. I found no outcome data for "heartbeat" or "ambient" agents, only design write-ups.

**Proactive coding assistants.**

- PR (CHI 2025, per the arXiv comment line; a randomized experiment). Proactive suggestions raised completion. [OPENED https://arxiv.org/pdf/2410.04596] "proactive assistants increase the number of tasks completed by 12-18%"
- Its sample. [OPENED https://arxiv.org/pdf/2410.04596] "We recruited a total of 65 students via university mailing lists."
- Same study. Frequency cut preference in half. [OPENED https://arxiv.org/pdf/2410.04596] "increasing the frequency of suggestions can negatively impact user experience, reducing participant preference for the proactive assistant over baseline by half"
- What changed between the liked and disliked versions: a shorter wait before speaking, more suggestions at once, and no guiding prompts. [OPENED https://arxiv.org/pdf/2410.04596] "from 20 seconds to 5 seconds" "from 3 to 5" "removing guiding prompts"
- The numbers. Most preferred the two calmer versions. Under half preferred the pushy one. [OPENED https://arxiv.org/pdf/2410.04596] "(90% and 80% of participants respectively)" "less than half of participants (47%) in the Persistent Suggest proactive condition preferred having the proactive assistant"
- In users' words. [OPENED https://arxiv.org/pdf/2410.04596] "they often found the assistant to be “distracting” and “annoying”"
- PR (CHI 2025, shown in the paper header). A small study. [OPENED https://arxiv.org/abs/2502.18658] "In a within-subject study (N=18)"
- Same study. Half of the proactive acts were used. A third were ignored. [OPENED https://arxiv.org/pdf/2502.18658] "we recorded 398 proactivity instances" "212 (53.3%) instances leading to effective user engagement, 48 (12.1%) instances of disruptions, and 138 (34.7%) instances of ignored AI proactivity"
- Same study. Timing at a task boundary worked best. [OPENED https://arxiv.org/pdf/2502.18658] "intervening at programmer’s task boundary — was the most effective design principle overall"
- Same study. Empty check-ins trained users to ignore the agent. [OPENED https://arxiv.org/pdf/2502.18658] "Many were affirmatory messages to acknowledge the completed code and ask if the user needs further help."
- Same study. [OPENED https://arxiv.org/pdf/2502.18658] "This led users to ignore around 50% of the proactive agent signals"
- Same study. A cost beyond annoyance. [OPENED https://arxiv.org/pdf/2502.18658] "some participants experienced a loss of code understanding"
- PP (ProactiveBench). Models do not know when to stay quiet. [OPENED https://arxiv.org/pdf/2410.12361] "they still frequently offer unnecessary help, even when instructed to provide only essential assistance"
- Same paper. Even the best tuned model was far from reliable at choosing when to help. [OPENED https://arxiv.org/abs/2410.12361] "our fine-tuned model achieves an F1-Score of 66.47% in proactively offering assistance"

**The cost of reading a suggestion.**

- PR (CHI 2024, per the arXiv comment line; a study of Copilot users). [OPENED https://arxiv.org/abs/2210.14306] "Our study of 21 programmers"
- Same study. Checking suggestions was the largest single activity. [OPENED https://arxiv.org/pdf/2210.14306] "the ‘verifying suggestion’ state takes up the most time at 22.4%"
- Same study. Half the session went to managing the tool. [OPENED https://arxiv.org/pdf/2210.14306] "the total time participants spend in these states is 51.5 %"
- PR (AAAI 2024, per the arXiv comment line). Many suggestions should not be shown. [OPENED https://arxiv.org/abs/2306.04930] "Using data from 535 programmers" "we can avoid displaying a significant fraction of suggestions that would have been rejected"

**Interruption cost.**

- PR (CHI 2007, shown in the paper; a logged field study). [OPENED https://erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf] "27 users over a two-week period" "participants spent on average nearly 10 minutes on switches caused by alerts"
- Same study. Some interrupted tasks stayed dropped. [OPENED https://erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf] "27% of task suspensions resulted in more than two hours of time until resumption"
- Research paper (Horvitz, "Principles of Mixed-Initiative User Interfaces"; I could not confirm the venue from the text). Wait for a better moment. [OPENED https://erichorvitz.com/chi99horvitz.pdf] "consider the costs and benefits of deferring action to a time when action will be less distracting"
- Same paper. Asking has a price too. [OPENED https://erichorvitz.com/chi99horvitz.pdf] "considering the costs of potentially bothering a user needlessly"
- Same paper. Under doubt, do less. [OPENED https://erichorvitz.com/chi99horvitz.pdf] "A preference for “doing less” but doing it correctly under uncertainty"
- Same paper. Make it easy to call and easy to dismiss. [OPENED https://erichorvitz.com/chi99horvitz.pdf] "providing efficient means by which users can directly invoke or terminate the automated services"

**Notification and approval fatigue.**

- PO (Google SRE book). Too many alerts hide the real one. [OPENED https://sre.google/sre-book/monitoring-distributed-systems/] "When pages occur too frequently, employees second-guess, skim, or even ignore incoming alerts"
- Same chapter. [OPENED https://sre.google/sre-book/monitoring-distributed-systems/] "Every page should be actionable."
- STD (Prometheus docs). [OPENED https://prometheus.io/docs/practices/alerting/] "avoid having pages where there is nothing to do"
- Government patient-safety primer (AHRQ). The same effect in hospitals. [OPENED https://psnet.ahrq.gov/primer/alert-fatigue] "clinicians then ignore both the bothersome, clinically meaningless alarms and the critical alerts"
- Its first remedy. [OPENED https://psnet.ahrq.gov/primer/alert-fatigue] "Increase alert specificity by reducing or eliminating clinically inconsequential alerts."
- VR (Anthropic, May 2026). Permission prompts wear out. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "Our telemetry showed users approved roughly 93% of permission prompts."
- Same post. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "The more approvals a user sees, the less attention they pay to each"
- VR (Anthropic, Oct 2025). One response was to cut the number of prompts. [OPENED https://www.anthropic.com/research/claude-code-sandboxing] "sandboxing safely reduces permission prompts by 84%"

**Ambient and heartbeat agents.** (Design write-ups only. No measured outcomes on these pages.)

- VR (LangChain, Jan 2025). The stated aim. [OPENED https://blog.langchain.com/introducing-ambient-agents/] "demand user input only when they detect important opportunities or require feedback"
- Three ways to reach the person. [OPENED https://blog.langchain.com/introducing-ambient-agents/] "notify, question, and review"
- STD (OpenClaw docs). A periodic check with a quiet default. [OPENED https://docs.openclaw.ai/gateway/heartbeat] "Return NO_REPLY when a check has no visible update."
- Same docs. Quiet does not swallow errors. [OPENED https://docs.openclaw.ai/gateway/heartbeat] "no_change suppresses automatic delivery; execution errors remain failures."

**Memory that surfaces unasked.**

- PO (Simon Willison, May 2025). Notes he could read felt fine. [OPENED https://simonwillison.net/2025/May/21/chatgpt-new-memory/] "I could browse those notes at any time to see exactly what was being recorded"
- Hidden recall did not. [OPENED https://simonwillison.net/2025/May/21/chatgpt-new-memory/] "The new memory feature removes that control completely."

**Terse status output.**

- PO (Command Line Interface Guidelines, a community guide). [OPENED https://clig.dev/] "Display output on success, but keep it brief."
- Same guide. Silence is rarely right, but lean short. [OPENED https://clig.dev/] "it’s usually best to err on the side of less"
- Same guide. Always report a change of state. [OPENED https://clig.dev/] "If you change state, tell the user."
- Same guide. Where the eye lands. [OPENED https://clig.dev/] "Put the most important information at the end of the output."
- Same guide. Noise slows the reader. [OPENED https://clig.dev/] "The more irrelevant output you produce, the longer it’s going to take the user to figure out what they did wrong."
- PO (Nielsen Norman Group). [OPENED https://www.nngroup.com/articles/visibility-system-status/] "systems should always keep users informed about what is going on, through appropriate feedback within reasonable time"
- A warning against forcing brevity on the agent itself. VR (Anthropic postmortem, Apr 2026). This instruction was added to the system prompt. [OPENED https://www.anthropic.com/research/april-23-postmortem] "Length limits: keep text between tool calls to ≤25 words."
- It was withdrawn four days later. [OPENED https://www.anthropic.com/research/april-23-postmortem] "On April 16, we added a system prompt instruction to reduce verbosity." "it hurt coding quality and was reverted on April 20"
- A wider test found the damage. [OPENED https://www.anthropic.com/research/april-23-postmortem] "One of these evaluations showed a 3% drop for both Opus 4.6 and 4.7."

**Design rule.**

- Default to silence when there is nothing to act on. But always report a state change and always report a failure.
- Speak at task boundaries: session start, after a commit, after a test run, before a hand-off. Not mid-edit.
- Each message must name one action the user can take. Drop "all good, need anything?" messages.
- Count your own messages. Track how many are acted on, ignored, or dismissed. Cut the kinds that are ignored.
- Make every proactive feature easy to turn off and easy to call by hand.
- Put the one line that matters last.
- Keep the plugin's own output short. Do not cap the agent's working text with a hard word limit.

---

## 9. Security of agent memory

**Finding.** Text that reaches durable memory acts as an instruction in later sessions. Attacks on this path are published for ChatGPT, Gemini, Amazon Bedrock Agents, Microsoft Copilot and Claude Code, and one vendor has seen attempts in the wild. No defence in the model is reliable on its own. The recommended controls are structural: limit what can write to memory, label where content came from, keep untrusted content away from durable writes, and keep memory readable so a person can audit it.

**Published attacks on memory.**

- Security researcher (Embrace The Red, May 2024). ChatGPT. [OPENED https://embracethered.com/blog/posts/2024/chatgpt-hacking-memories/] "write misinformation, bias and even instructions into your ChatGPT’s memories, and also create a form of persistence"
- Same researcher (Sep 2024). Stored instructions that leaked every later chat. [OPENED https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/] "attackers could insert long-term persistent spyware into ChatGPT’s memory"
- Same post. The leak was fixed. The write path was not. [OPENED https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/] "A website or untrusted document can still invoke the memory tool to store arbitrary memories."
- Same researcher (Feb 2025). Gemini. A planted "if the user says yes" trick got past the tool block. [OPENED https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/] "Gemini, believing it’s following the user’s direct instruction, executes the tool"
- VR (Palo Alto Unit 42, Oct 2025). Amazon Bedrock Agents. The end-of-session summary was the way in. [OPENED https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/] "manipulates the agent’s session summarization process, causing the injected instructions to be stored in memory"
- Same report. Why stored text is strong. [OPENED https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/] "they are often prioritized over user input"
- PP (MINJA). An ordinary user can poison a shared memory. [OPENED https://arxiv.org/abs/2503.03704] "by only interacting with the agent via queries and output observations"
- PP (AgentPoison). A tiny amount of planted memory is enough. [OPENED https://arxiv.org/abs/2407.12784] "an average attack success rate higher than 80% with minimal impact on benign performance (less than 1%) with a poison rate less than 0.1%"
- VR (Microsoft Security, Feb 2026). Seen in the wild, for marketing. [OPENED https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/] "We identified over 50 unique prompts from 31 companies across 14 industries"
- Same post. [OPENED https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/] "the AI treats these injected instructions as legitimate user preferences"

**Attacks on coding-agent memory and hooks.**

- VR (Cisco, Apr 2026). Claude Code. A package install script rewrote memory files and the global hook settings. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "The payload modifies the model’s memory files and overwrites every project’s memory"
- Same post. The effect. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "maintain persistence beyond our immediate session into every project, every session, and even after reboots"
- Same post. Why it worked. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "models assume they were written by the user and implicitly trust them"
- Same post. The hook used. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "This specifically targeted the UserPromptSubmit hook, which executes before every prompt."
- Same post. Anthropic's change. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "removes user memories from the system prompt"
- Same post. Anthropic's stated boundary. Code running as the user may edit memory. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "Users (and by extension, scripts running as the user) are intentionally allowed to modify settings and memories."
- PO (OWASP GenAI Security Project blog, May 2026, by the lead of the memory-poisoning entry, who is one of the Cisco authors). The ordinary path. [OPENED https://genai.owasp.org/2026/05/13/memory-is-a-feature-it-is-also-an-attack-surface/] "clone a repository, let the agent help, approve a dependency installation, and move on"
- STD (OWASP exploit roundup, Q3 2026). A supply-chain worm that persisted through agent config. [OPENED https://genai.owasp.org/2026/10/08/genai-and-agentic-ai-exploit-roundup-q3-2026/] "planted a Claude Code hook and VS Code task that uninstalling the affected package did not remove"
- Same roundup. Config files as the trigger. [OPENED https://genai.owasp.org/2026/10/08/genai-and-agentic-ai-exploit-roundup-q3-2026/] "The malicious changes added configuration files for Claude Code, Gemini CLI, Cursor and VS Code that could execute when a repository was opened."
- Same roundup, on Microsoft Copilot. A web-page summary wrote to assistant memory. [OPENED https://genai.owasp.org/2026/10/08/genai-and-agentic-ai-exploit-roundup-q3-2026/] "CoSnitch Copilot prompt execution and memory poisoning" "A related webpage-summarization path wrote malicious instructions into persistent memory."
- VR (Anthropic, May 2026). Hooks in a cloned repository ran before the trust prompt. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "the hook the attacker had authored and committed would execute automatically"
- Same post. The fix. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "defer parsing and execution of project-local configuration until after the user accepts the trust prompt"
- Same post. Anthropic names this as a growing risk. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "An injection that lands in any of these is reloaded each time the agent starts."
- Same post. What counts as persistent. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "this includes product memory, CLAUDE.md files, mounted workspaces, and the state directories of scheduled and long-running agents"

**The framings.**

- PO (Simon Willison, Jun 2025). The three ingredients. [OPENED https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/] "The lethal trifecta for AI agents: private data, untrusted content, and external communication"
- Same post. The root cause. [OPENED https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/] "LLMs are unable to reliably distinguish the importance of instructions based on where they came from."
- Same post. Filters are not enough. [OPENED https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/] "in web application security 95% is very much a failing grade"
- Same post. [OPENED https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/] "The only way to stay safe there is to avoid that lethal trifecta combination entirely."
- Same post, quoting a design-patterns paper. [OPENED https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/] "once an LLM agent has ingested untrusted input, it must be constrained so that it is impossible for that input to trigger any consequential actions"
- VR (Meta, Oct 2025). The Rule of Two. [OPENED https://ai.meta.com/blog/practical-ai-agent-security/] "agents must satisfy no more than two of the following three properties within a session"
- The third property covers writing state. [OPENED https://ai.meta.com/blog/practical-ai-agent-security/] "[C] An agent can change state or communicate externally"
- If all three are needed. [OPENED https://ai.meta.com/blog/practical-ai-agent-security/] "at a minimum requires supervision — via human-in-the-loop approval or another reliable means of validation"
- Inference: both framings count risk "within a session". Durable memory breaks that. A new session that loads a poisoned note has already taken in untrusted input.
- PO (Willison, Nov 2025, quoting a paper I did not open). Published defences fell to adaptive attack. [OPENED https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/] "we bypass 12 recent defenses (based on a diverse set of techniques) with attack success rate above 90% for most"
- VR (Anthropic, Nov 2025). The vendor agrees it is unsolved. [OPENED https://www.anthropic.com/research/prompt-injection-defenses] "A 1% attack success rate—while a significant improvement—still represents meaningful risk."
- VR (Anthropic, May 2026). [OPENED https://www.anthropic.com/research/how-we-contain-claude] "protection in the model layer will never be 100% effective"

**OWASP entries.**

- STD (OWASP LLM01:2025 Prompt Injection). [OPENED https://genai.owasp.org/llmrisk/llm01-prompt-injection/] "it is unclear if there are fool-proof methods of prevention for prompt injection"
- Least privilege. [OPENED https://genai.owasp.org/llmrisk/llm01-prompt-injection/] "Restrict the model’s access privileges to the minimum necessary for its intended operations."
- Human approval. [OPENED https://genai.owasp.org/llmrisk/llm01-prompt-injection/] "Implement human-in-the-loop controls for privileged operations to prevent unauthorized actions."
- Label untrusted content. [OPENED https://genai.owasp.org/llmrisk/llm01-prompt-injection/] "Separate and clearly denote untrusted content to limit its influence on user prompts."
- STD (OWASP LLM08:2025 Vector and Embedding Weaknesses). Audit the store. [OPENED https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/] "Regularly audit and validate the integrity of the knowledge base for hidden codes and data poisoning."
- Tag by source. [OPENED https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/] "Tag and classify data within the knowledge base to control access levels and prevent data mismatch errors."
- STD (OWASP LLM04:2025 Data and Model Poisoning). Provenance. [OPENED https://genai.owasp.org/llmrisk/llm042025-data-and-model-poisoning/] "Track data origins and transformations using tools like OWASP CycloneDX or ML-BOM."
- STD (OWASP Top 10 for Agentic Applications 2026, published 9 Dec 2025). The landing page opened. The document itself is a gated download and I could not open it. [OPENED https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/] "a globally peer-reviewed framework that identifies the most critical security risks facing autonomous and agentic AI systems"
- The memory entry is ASI06. Its name is confirmed by an OWASP blog post from its lead. [OPENED https://genai.owasp.org/2026/05/13/memory-is-a-feature-it-is-also-an-attack-surface/] "As co-lead of OWASP ASI06: Memory & Context Poisoning entry"
- His summary. [OPENED https://genai.owasp.org/2026/05/13/memory-is-a-feature-it-is-also-an-attack-surface/] "memory should be treated as part of the attack surface"
- On hooks. [OPENED https://genai.owasp.org/2026/05/13/memory-is-a-feature-it-is-also-an-attack-surface/] "A hook is not just a script. It can shape every interaction."
- STD (OWASP Agent Memory Guard project page). [OPENED https://owasp.org/www-project-agent-memory-guard/] "Anything written into that memory becomes a privileged input on the next turn."
- The wording of ASI06's mitigations, and of threat T1 "Memory Poisoning" in OWASP's "Agentic AI – Threats and Mitigations", is search-only. [SEARCH-ONLY https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/] A search extract lists validating content before storage, isolating memory per session and user, provenance tracking, and expiry of suspect entries.
- VR (Microsoft). MITRE has a matching technique. [OPENED https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/] "AML.T0080: Memory Poisoning"

**Recommended mitigations, and how well each is supported.**

- Provenance on every entry. Recommended by OWASP (above). Built into Graphiti, and into Copilot's memory as citations (§3). [OPENED https://raw.githubusercontent.com/getzep/graphiti/main/README.md] "Every entity and relationship traces back to the episodes (raw data) that produced it."
- Scope who can write. VR (GitHub). [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "Memories for a given repository can only be created in response to actions taken within that repository by contributors with write permissions"
- Quarantine untrusted content. VR docs (Claude Code). The model sees a summary of a web page, not the page. [OPENED https://code.claude.com/docs/en/security.md] "WebFetch runs a separate model call over the page, and Claude receives that call's answer instead of the raw page"
- A limit of quarantine. VR (Anthropic). A sub-agent's summary is not automatically safe. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "if a sub-agent's output is treated as higher-trust than raw tool results"
- PP (CaMeL). The strict form: untrusted data never steers control flow. [OPENED https://arxiv.org/abs/2503.18813] "the untrusted data retrieved by the LLM can never impact the program flow"
- Its price, per the abstract: 77% of benchmark tasks solved, against 84% with no defence. [OPENED https://arxiv.org/abs/2503.18813] "of tasks with provable security"
- PP (design-patterns paper, abstract only). The same idea as a set of patterns. [OPENED https://arxiv.org/abs/2506.08837] "we propose a set of principled design patterns for building AI agents with provable resistance to prompt injection"
- Human approval for durable writes. Researcher's recommendation. [OPENED https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/] "Require explicit user confirmation before persisting new memories."
- And after untrusted input. [OPENED https://embracethered.com/blog/posts/2025/gemini-memory-persistence-prompt-injection/] "Once the chat context is polluted with untrusted data, all sensitive tool invocations should require user confirmation."
- The limit of approval. People approve almost everything (§8, 93%). And a trigger word is not consent, as the Gemini case shows. Inference: an approval is only worth something if it is rare and shows the exact text to be stored.
- Least privilege for the store itself. VR docs (Anthropic memory tool). [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "Your implementation must validate every path in every command to prevent directory traversal attacks."
- No secrets in memory. Same docs. [OPENED https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md] "add validation that strips sensitive data before your handler writes the file"
- Audit by the user. Researcher. [OPENED https://embracethered.com/blog/posts/2024/chatgpt-hacking-memories/] "Users should regularly inspect the Memory of your ChatGPT to cross-check what got stored."
- VR (Microsoft). [OPENED https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/] "Delete suspicious entries: If you see memories you don’t remember creating, remove them."
- This needs readable storage. VR docs (Claude Code). [OPENED https://code.claude.com/docs/en/memory.md] "Auto memory files are plain markdown you can edit or delete at any time."
- Watch the config directories. STD (OWASP roundup). [OPENED https://genai.owasp.org/2026/10/08/genai-and-agentic-ai-exploit-roundup-q3-2026/] "add AI coding-tool configuration directories to file-integrity monitoring"
- Check at read time. VR (GitHub's own test with planted false memories, §4). Evidence from one vendor.
- Check at start-up. VR (Anthropic). A direction, not yet a product. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "Good classifiers on session startup will need to become more commonplace."
- Do not rely on prompt wording. STD (OWASP roundup). [OPENED https://genai.owasp.org/2026/10/08/genai-and-agentic-ai-exploit-roundup-q3-2026/] "Prompt-level instructions alone do not establish a secure boundary."
- Vendor pushback worth noting. Amazon told Unit 42 the platform's guardrails cover its case. [OPENED https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/] "these concerns are easy to mitigate by enabling Bedrock platform features designed to reduce such risks"

**Guidance for unattended agents.**

- VR (Meta). An agent with all three risky properties should not run alone (quoted above).
- VR (Anthropic, May 2026). Unattended runs belong in a tight sandbox. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "Claude Code’s reference devcontainer exists precisely so that the agent can run unattended, without per-action approvals."
- Same post. Treat local config as hostile input. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "treat project-open, config-load, and localhost listeners the way you'd treat any inbound request from the internet"
- VR docs (Claude Code headless mode). Non-interactive runs skip the trust prompt. [OPENED https://code.claude.com/docs/en/headless.md] "A `-p` session shows no workspace trust dialog and no per-server approval prompt."
- VR docs (Claude Code hooks). So repository hooks run. [OPENED https://code.claude.com/docs/en/hooks.md] "hooks committed in a repository's `.claude/settings.json` run in a folder you've never trusted"
- Same docs. What a hook can do. [OPENED https://code.claude.com/docs/en/hooks.md] "Command hooks execute shell commands with your full user permissions."
- VR (Anthropic, Mar 2026). The auto-mode classifier treats new persistence as a danger sign. [OPENED https://www.anthropic.com/research/claude-code-auto-mode] "installing persistence like SSH keys or cronjobs, or modifying the agent's own permission config"
- VR (Anthropic, May 2026). After a successful injection the logs look normal. [OPENED https://www.anthropic.com/research/how-we-contain-claude] "the log just shows a successful, authorized API call"

**Design rule.**

- A memory file is an instruction channel. Review a change to it the way you review a change to code.
- Do not write durable memory from a turn that has read web pages, issue text, tool output from outside, or files from an untrusted repository, unless a person sees the exact text first.
- When unattended, do not promote anything to the always-loaded layer. Append to a quarantine file with its source, and let a person promote it later.
- Label every entry with where it came from. Keep "the user said", "the agent concluded" and "copied from a file" apart.
- Present memory to the model as notes that may be wrong, not as rules.
- Keep memory in plain files under version control, so a diff shows what changed and who changed it.
- Keep hooks few, small and fixed. No network. No reading of repository-supplied config before trust. No writes outside the memory directory.
- Never store secrets. Validate every path.
- Tell the user, briefly, each time durable memory changes.

---

## 10. Silent failure in instrumentation

**Finding.** The dangerous failure is the one that reports nothing. A peer-reviewed study traces most catastrophic failures in five production systems to errors that were signalled and then handled badly, often just logged or ignored. Monitoring practice answers with three habits: treat missing data as its own state, send a heartbeat, and probe with a known answer. Agent harnesses have the same trap built in: a broken hook does not stop anything.

**Evidence that swallowed errors cause the worst failures.**

- PR (OSDI 2014, shown in the paper). The sample. [OPENED https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf] "We studied 198 randomly sampled, real world failures reported on five popular distributed data-analytic and storage systems"
- The headline. [OPENED https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf] "almost all (92%) of the catastrophic system failures are the result of incorrect handling of non-fatal errors explicitly signaled in software"
- Same paper. Logging and moving on counts as ignoring. [OPENED https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf] "an error handler that only logs the error is also considered as ignoring the error"
- Same paper. A common pattern. [OPENED https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf] "the error handler is simply empty or only contains a log printing statement"
- Same paper. Cheap tests would have caught most. [OPENED https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf] "in 58% of the catastrophic failures, the underlying faults could easily have been detected through simple testing of error handling code"
- PO (Jim Shore, "Fail Fast", IEEE Software, 2004). [OPENED https://martinfowler.com/ieeeSoftware/failFast.pdf] "when a problem occurs, it fails immediately and visibly"
- Same article. A default value hides the fault. [OPENED https://martinfowler.com/ieeeSoftware/failFast.pdf] "a default value, everything will seem fine"

**Unknown is not zero, and absent is not healthy.**

- STD (Kubernetes API conventions). Three values, not two. [OPENED https://raw.githubusercontent.com/kubernetes/community/master/contributors/devel/sig-architecture/api-conventions.md] "Condition `status` values may be `True`, `False`, or `Unknown`."
- Same document. Missing means unknown. [OPENED https://raw.githubusercontent.com/kubernetes/community/master/contributors/devel/sig-architecture/api-conventions.md] "The absence of a condition should be interpreted the same as `Unknown`."
- STD (Nagios plugin guidelines). OK requires that the check ran. [OPENED https://nagios-plugins.org/doc/guidelines.html] "The plugin was able to check the service and it appeared to be functioning properly"
- Same guidelines. A check that could not run has its own code. [OPENED https://nagios-plugins.org/doc/guidelines.html] "low-level failures internal to the plugin that prevent it from performing the specified operation"
- VR docs (Grafana). No data is a state. [OPENED https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/] "No Data state occurs when the alert rule query runs successfully but returns no data points."
- Same docs. So is a failed query. [OPENED https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/] "Error state occurs when the alert rule fails to evaluate its query or queries successfully."
- VR docs (Datadog). A monitor that never saw data stays quiet. [OPENED https://docs.datadoghq.com/monitors/configuration/] "The monitor must be able to evaluate data before alerting on missing data."
- Same docs. One default turns missing into zero. [OPENED https://docs.datadoghq.com/monitors/configuration/] "Count queries default to Evaluate as zero"
- STD (Prometheus docs). Publish an explicit zero for series you know should exist, so that "absent" keeps its meaning. [OPENED https://prometheus.io/docs/practices/instrumentation/] "export a default value such as 0 for any time series you know may exist in advance"
- STD (Prometheus docs). There is a function for absence. [OPENED https://prometheus.io/docs/prometheus/latest/querying/functions/] "This is useful for alerting on when no time series exist for a given metric name and label combination."

**Heartbeats, canaries and dead-man's switches.**

- STD (Prometheus docs). Send a dummy item through the whole path. [OPENED https://prometheus.io/docs/practices/instrumentation/] "send a heartbeat through the system: some dummy item that gets passed all the way through"
- Same docs. For jobs that run now and then. [OPENED https://prometheus.io/docs/practices/instrumentation/] "The key metric of a batch job is the last time it succeeded."
- STD (Prometheus alerting practices). Monitor the monitor. [OPENED https://prometheus.io/docs/practices/alerting/] "It is important to have confidence that monitoring is working."
- STD (kube-prometheus runbook). An alert that must always fire. [OPENED https://runbooks.prometheus-operator.dev/runbooks/general/watchdog/] "This alert is always firing, therefore it should always be firing in Alertmanager"
- Same runbook. Its silence is the alarm. [OPENED https://runbooks.prometheus-operator.dev/runbooks/general/watchdog/] "If not firing then it should alert external systems that this alerting system is no longer working."
- VR docs (Healthchecks.io). The same idea for scheduled jobs. [OPENED https://healthchecks.io/docs/] "It raises an alert as soon as a ping does not arrive on time."
- PO (Google SRE book). Internal counters miss what never arrived. [OPENED https://sre.google/sre-book/practical-alerting/] "You can only alert on the failures that you expected."
- Same chapter. Hence an outside probe that checks the content of the reply. [OPENED https://sre.google/sre-book/practical-alerting/] "Prober can validate the response payload"
- Same chapter. Each target also gets "did I reach it" variables. [OPENED https://sre.google/sre-book/practical-alerting/] "These synthetic variables make it easy to write rules to detect if the monitored tasks are unavailable."
- Same chapter. The rules themselves are tested with fake data. [OPENED https://sre.google/sre-book/practical-alerting/] "Borgmon provides a way to build extensive unit and regression tests by synthesizing time-series data"

**The same trap in agent harnesses and evals.**

- VR docs (Claude Code hooks). A hook that crashes or cannot start does not stop the action. [OPENED https://code.claude.com/docs/en/hooks.md] "your hook exits with any other code, or fails in some other way, such as not starting or printing invalid JSON. The action goes ahead"
- Same docs. [OPENED https://code.claude.com/docs/en/hooks.md] "a hook that can't start is a non-blocking error too"
- Same docs. The model does not see a quiet hook's error text. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude never sees stderr from a hook that exits 0."
- Same docs. Exit code 1 does not block. [OPENED https://code.claude.com/docs/en/hooks.md] "Exit code 1 without valid JSON output is a non-blocking error" "If your hook is meant to enforce a policy, use `exit 2`."
- Same docs. Long injected context is swapped for a file path and a short preview. [OPENED https://code.claude.com/docs/en/hooks.md] "If a value exceeds 10,000 characters, Claude Code writes the text to a file in the session directory"
- Same docs. The model may never open that file. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude can read the file, but Claude Code doesn't ask it to."
- VR docs (Claude Code memory). An over-long memory index loses its tail at the next load. The write itself succeeds. The harness does tell the model to fix it. [OPENED https://code.claude.com/docs/en/memory.md] "If the file is over a limit, the write still succeeds" "error telling Claude to rewrite the index" "everything past the limit is dropped on the next load"
- VR docs (Claude Code headless). In bare mode a plugin is simply not there. [OPENED https://code.claude.com/docs/en/headless.md] "skipping auto-discovery of hooks, skills, custom commands" "installed plugins, MCP servers, auto memory, and CLAUDE.md"
- Same docs. Bare mode is set to become the default for scripted runs. [OPENED https://code.claude.com/docs/en/headless.md] "will become the default for `-p` in a future release"
- Same docs. A server that fails validation is skipped and the run still exits clean. [OPENED https://code.claude.com/docs/en/headless.md] "The run continues and exits cleanly, so check these fields to catch a server that never loaded"
- VR (Anthropic evals post). A claim of success is not the outcome. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "A flight-booking agent might say “Your flight has been booked” at the end of the transcript, but the outcome is whether a reservation exists"
- Same post. A flat zero usually means the measuring is broken. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "is most often a signal of a broken task, not an incapable agent"
- Same post. The canary for a grader is a known-good answer. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "This proves that the task is solvable and verifies graders are correctly configured."
- Same post. Grading bugs hid a strong result. [OPENED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents] "Opus 4.5 initially scored 42% on CORE-Bench" "Opus 4.5’s score jumped to 95%"
- VR (skill-creator grader). A check that passes on empty output. [OPENED https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/agents/grader.md] "correct filename but empty/wrong content"
- VR (Anthropic, Nov 2025). Start every item as failing. [OPENED https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents] "These features were all initially marked as “failing”"
- Same post. Agents declare victory early. [OPENED https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents] "see that progress had been made, and declare the job done"
- VR (Anthropic, Mar 2026). And they wave away their own findings. [OPENED https://www.anthropic.com/research/harness-design-long-running-apps] "identify legitimate issues, then talk itself into deciding they weren't a big deal and approve the work anyway"
- VR (Anthropic postmortem, Sep 2025). Evals passed while users saw worse output. [OPENED https://www.anthropic.com/research/a-postmortem-of-three-recent-issues] "The evaluations we ran simply didn't capture the degradation users were reporting"
- VR (Anthropic postmortem, Apr 2026). A context-management bug passed every check. [OPENED https://www.anthropic.com/research/april-23-postmortem] "made it past multiple human and automated code reviews, as well as unit tests, end-to-end tests, automated verification, and dogfooding"
- VR (Anthropic, Feb 2026). Rig failures were being counted as task failures. [OPENED https://www.anthropic.com/research/infrastructure-noise] "as many as 6% of tasks were failing because of pod errors"
- PP (MERIT). A "success" that came from leftover state (§7).

**Design rule.**

- Every check returns one of three values: ok, failed, not measured. Never fold the third into the first.
- A count of zero is only valid if the counter was read. Otherwise print "unknown".
- Each instrument writes a heartbeat with a time stamp every time it runs. A reader that finds no fresh heartbeat reports "not running", not "nothing happened".
- Ship a known-answer probe. Plant a fact, ask for it, and confirm the whole path returns it.
- Test the instrument by breaking it on purpose. If the report does not change, the instrument is not measuring.
- Measurement code must not swallow errors. No empty handlers. No "log and continue" on the measuring path.
- Assume a hook failure is silent to the model. Surface it to the user yourself.
- State in the plugin's own output when it is absent or degraded, for example in bare mode.

---

## Twelve design rules the evidence supports

Each rule is one sentence. Each names its strongest source. Grades: STRONG = peer-reviewed or replicated across independent sources. MODERATE = preprints, vendor studies with data, or small peer-reviewed studies. WEAK = opinion or a single anecdote.

1. Keep the always-loaded memory small and fixed in size, and load everything else on demand. **STRONG.** [OPENED https://arxiv.org/abs/2402.14848] "a notable degradation in LLMs' reasoning performance at much shorter input lengths than their technical maximum"
2. Inject a few precise notes rather than many loosely related ones, and never two versions of one fact. **STRONG.** [OPENED https://aclanthology.org/2024.acl-long.747.pdf] "This improvement falters with an increase in the number of retrieved observations"
3. Store memory as plain files with a short index and let the agent search them, and add embeddings only after a measured miss. **MODERATE.** [OPENED https://arxiv.org/abs/2605.12493] "AgentRunbook-C achieves the best performance with 72.5% average accuracy, outperforming the strongest RAG baseline (48.5%) and the off-the-shelf coding agent baseline (69.3%)"
4. Let the agent decide what to save, tell it what memory is for, and save only what the repository cannot tell it. **MODERATE.** [OPENED https://www.anthropic.com/research/components-of-agent-memory] "it helps to tell Claude what memory is for, but not how to use it"
5. Give every note a source pointer and a checked-or-unchecked mark, and re-check the pointer before acting on the note. **MODERATE.** [OPENED https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/] "we store memories with citations: references to specific code locations that support each fact"
6. When a fact changes, replace it in place and keep the old value only as dated history. **MODERATE.** [OPENED https://arxiv.org/abs/2609.05441] "update-on-write stores (a structured fact store and, notably, LLM summarization) remain at 0.70-1.00"
7. Never let a summary be the only copy, and keep paths, errors, decisions and the user's constraints word for word. **STRONG.** [OPENED https://arxiv.org/pdf/2410.10813] "replacing sessions or rounds with extracted summaries or facts negatively impacts QA performance due to information loss"
8. Do not choose or defend a memory design with LoCoMo, DMR or LongMemEval-S scores. **MODERATE.** [OPENED https://arxiv.org/pdf/2504.19413] "a full-context method that ingests a chunk of roughly 26,000 tokens still achieves the highest J score (approximately 73%)"
9. Judge the plugin by running the same tasks with and without it, several times, graded on outcomes and cost, with any LLM judge blinded and run in both orders. **STRONG.** [OPENED https://arxiv.org/abs/2306.05685] "including position, verbosity, and self-enhancement biases, as well as limited reasoning ability" [OPENED https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/] "even after experiencing the slowdown, they still believed AI had sped them up by 20%"
10. Speak unprompted only at task boundaries, only with something the user can act on, and less often than feels helpful. **MODERATE.** [OPENED https://arxiv.org/pdf/2410.04596] "increasing the frequency of suggestions can negatively impact user experience, reducing participant preference for the proactive assistant over baseline by half"
11. Treat every memory file and hook as an instruction channel, and let nothing from untrusted content become durable without a person seeing the exact text. **STRONG** for the threat; the controls are recommended practice, not measured. [OPENED https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code] "maintain persistence beyond our immediate session into every project, every session, and even after reboots"
12. Report three states (ok, failed, not measured) and prove each instrument is alive with a heartbeat and a known-answer probe. **MODERATE.** The failure pattern is peer-reviewed; the remedy is standard practice; its use on agent telemetry is by analogy. [OPENED https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf] "an error handler that only logs the error is also considered as ignoring the error"

Notes on the grades.

- Rule 3 has real counter-evidence. Cursor reports gains from semantic search on large codebases, and LongMemEval found embeddings beat BM25 for one-shot retrieval over chat logs (§2).
- Rule 4 rests mostly on one vendor post with small samples (§3). The supporting study on context files is a preprint (§1).
- Rule 8 is graded MODERATE because the audit of LoCoMo is self-published. The "fits in context" point is confirmed by the vendors' own papers.
- Rule 9 is STRONG for judge bias. The with-and-without method itself is guidance from Anthropic plus one randomized trial showing that self-report misleads (§7).
- Rule 10 rests on two small peer-reviewed studies with students and short tasks (§8).

---

## Blocked hosts

**The brief said `arxiv.org` and `research.trychroma.com` were blocked. In this session they were not.** The coordinator later sent a correction saying the same: the early refusals were a proxy start-up condition, not policy.

- The proxy log shows both refused at 19:58 UTC (HTTP 403 on connect). So were `docs.letta.com`, `developers.openai.com` and `antigravity.google`.
- From 20:04 UTC, direct `curl` to `arxiv.org` returned HTTP 200. `research.trychroma.com` returned a redirect to `www.trychroma.com/research`, which returned 200.
- The environment's own settings report unrestricted network access.
- I fetched both directly. I used no relay, proxy, mirror, cache or archive service at any point.
- Every paper claim in this digest is tagged OPENED against an `arxiv.org` page, a publisher page, or an author-hosted PDF. None rests on a GitHub README alone. READMEs are cited only for facts about the repository itself, such as the size of a data release.
- I did not test `developers.openai.com` or `antigravity.google`.

**Hosts the brief listed as reachable.** All were: www.anthropic.com, platform.claude.com, code.claude.com, raw.githubusercontent.com, pypi.org, modelcontextprotocol.io. I did not need pypi.org or modelcontextprotocol.io for any claim.

**Hosts the brief asked me to try.**

| Host | Result |
|---|---|
| aclanthology.org | Reachable. Used. |
| openreview.net | Front page returned 200. A paper page redirected to a bot challenge. Not used. |
| huggingface.co | Reachable. Used for one data card. |
| simonwillison.net | Reachable. Used. |
| genai.owasp.org | Web pages reachable and used. The two agentic PDF downloads returned a "No Access" page. |
| owasp.org | Reachable. Used. |
| lilianweng.github.io | Reachable. Read, not cited. |
| blog.langchain.com | Reachable. Redirects to `www.langchain.com/blog`. Used. |
| www.letta.com | Reachable. Used. |
| blog.getzep.com | Reachable. Redirects to `www.getzep.com/blog`. Used. |
| mem0.ai | Reachable. Used. |
| cognition.ai | Reachable. Redirects to `cognition.com`. Used. |
| manus.im | Reachable. Used. |
| hamel.dev | Reachable. Used. |
| eugeneyan.com | Reachable. Used. |
| metr.org | Reachable. Used. |

**Hosts that failed. I did not work around any of them.**

| Host | What happened | What I could not open |
|---|---|---|
| genai.owasp.org (downloads) | Redirect to a "No Access" page | OWASP Top 10 for Agentic Applications 2026; Agentic AI – Threats and Mitigations |
| openreview.net (paper pages) | Bot challenge | Venue records for several papers |
| dl.acm.org | HTTP 403 from the site | ACM copies of the CHI and UIST papers. I used author-hosted or arXiv copies instead |
| ics.uci.edu, www.ics.uci.edu | TLS certificate check failed | Mark et al., "The cost of interrupted work" |
| www.catb.org | TLS name mismatch; plain HTTP not routed | Raymond, "The Art of Unix Programming" (rule of silence) |
| nlp.stanford.edu | Connection reset | Manning et al., IR book chapter on ranked retrieval metrics |
| cseweb.ucsd.edu | TLS certificate check failed | The page a search gave for MemoryAgentBench's venue |
| api.github.com via `gh` | Repository not attached to this session | A GitHub issue. I read it through WebFetch instead and said so where cited |

**Redirects worth knowing.** Several `www.anthropic.com/engineering/…` and `/news/…` addresses now redirect to `www.anthropic.com/research/…` or `claude.com/resources/articles/…`. `platform.claude.com/…/long-context-tips.md` redirects to the prompting best-practices page. `factory.ai` redirects to `factory.com`.

**Other hosts used without trouble.** platform.claude.com, code.claude.com, raw.githubusercontent.com, github.blog, blogs.cisco.com, www.microsoft.com, ai.meta.com, unit42.paloaltonetworks.com, embracethered.com, latent.space, cursor.com, cline.bot, factory.ai, dev.to, www.dbreunig.com, sre.google, prometheus.io, runbooks.prometheus-operator.dev, grafana.com, docs.datadoghq.com, healthchecks.io, nagios-plugins.org, www.usenix.org, martinfowler.com, erichorvitz.com, psnet.ahrq.gov, clig.dev, www.nngroup.com, docs.openclaw.ai, docs.mem0.ai, help.getzep.com, scikit-learn.org, en.wikipedia.org, www.amazon.science.

---

## Unconfirmed — do not rely on

These are things I believe or that a search extract said. I did not confirm them on a page I opened.

**Venues I could not confirm.** The pages I opened show these only as arXiv preprints.

- MemoryBank at AAAI 2024.
- AgentPoison at NeurIPS 2024.
- "Making Retrieval-Augmented Language Models Robust to Irrelevant Context" at ICLR 2024.
- "Long-Context LLMs Meet RAG" at ICLR 2025.
- "LLM Evaluators Recognize and Favor Their Own Generations" at NeurIPS 2024.
- MemoryAgentBench at ICLR 2026. [SEARCH-ONLY https://cseweb.ucsd.edu/~jmcauley/reviews/iclr26c.pdf]
- Horvitz, "Principles of Mixed-Initiative User Interfaces", at CHI 1999. The file name says so. The extracted text does not.
- I did confirm one I had first doubted: "The Power of Noise" shows SIGIR 2024 on its arXiv HTML page. [OPENED https://arxiv.org/html/2401.14887v4] "Proceedings of the 47th International ACM SIGIR Conference on Research and Development in Information Retrieval"

**Content I could not open.**

- The text of OWASP ASI06 and its listed mitigations. The download is gated.
- The text of threat T1 "Memory Poisoning" in OWASP's "Agentic AI – Threats and Mitigations". Same reason.
- The paper "The Attacker Moves Second". I quoted it only through Simon Willison's post.
- The design-patterns paper's body. I opened its abstract and quoted one line through Willison's post.
- CL-Bench itself. I have only Anthropic's description.
- Gloria Mark's finding that it takes about 23 minutes to return to an interrupted task. Widely repeated. I could not open a source.
- The Unix "rule of silence". I could not open the source.
- The Chroma report's per-model figures. They are in charts that did not extract as text. I quoted only the prose.

**Claims seen second-hand.**

- That Claude Code auto-compacts at 95% of the window. A LangChain blog says so. I did not find it in the Claude Code docs I opened.
- That a Databricks study found accuracy falling from about 32k tokens for one model. Reported by Drew Breunig. Not opened.
- That Mastra's memory scored 84.23% against a 60.20% full-context baseline on LongMemEval. Reported by Penfield Labs. Not opened.
- The exact GitHub issue text for the Mem0–Zep dispute. I read a model-written extract through WebFetch, not the raw page.

**My own inferences, flagged in the text.**

- That durable memory defeats "within a session" security rules (§9).
- That blinding does not hide style, so length should be equalized before a judge compares outputs (§7).
- That an approval prompt is only useful if it is rare and shows the exact text (§9).
- That no single top-k is right (§2).

**Gaps.**

- I found no study that compares write timing (every turn, session end, agent-initiated) head to head for coding agents.
- I found no measured outcomes for heartbeat or ambient agents.
- I found no benchmark for a growing, file-based project memory in a coding agent. The nearest is the AGENTS.md study of static files.
- I found no measurement of how well provenance labels, quarantine or approval prompts stop memory poisoning in practice.

