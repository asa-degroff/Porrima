# Memory Architecture Review & Comparison

*Generated 2026-03-11*

## Your Architecture at a Glance

- **Storage**: SQLite + sqlite-vec (1024-dim embeddings from `qwen3-embedding:0.6b`)
- **Extraction**: Fire-and-forget LLM extraction after each response → atomic facts with category + importance
- **Dedup**: Cosine > 0.85 → UPDATE instead of INSERT
- **Retrieval**: KNN oversample 3x → re-rank by `cosine_sim * recency_decay * (importance / 10)` (30-day half-life)
- **Synthesis**: Daily consolidation (merge at 0.90 cosine), importance decay, purging, daily summaries, persona pattern detection
- **Persona**: Evolving markdown identity document with versioned history
- **Agent tools**: `save_memory`, `search_memory`, `forget_memory`, `update_persona`
- **Context injection**: Last 3 user messages → search top 5 memories → inject into system prompt

---

## How It Compares to Major Systems

**Most similar to: Mem0 + CrewAI hybrid**

The extraction→dedup→score pipeline closely mirrors Mem0's approach (extract facts from conversations, compare against existing memories, ADD/UPDATE). The scoring formula is nearly identical to CrewAI's (`semantic * recency_decay * importance` with a 30-day half-life and 0.85 dedup threshold).

---

## Strengths

1. **Fully local & private** — Everything runs on Ollama + SQLite. No cloud dependencies. Genuine differentiator vs. Mem0, Zep, LangMem which all assume cloud vector DBs or managed services.

2. **Persona system is unique** — Most systems store facts but don't evolve an identity document. The synthesis→pattern detection→persona suggestion pipeline is genuinely novel. MemGPT has a "persona" core memory block, but it doesn't do automatic pattern-based evolution.

3. **Pre-compaction flush** — Extracting memories before context window truncation (at 75% capacity) is smart. MemGPT does something similar with its 70%/100% thresholds, but this approach extracts from the *entire* conversation rather than just summarizing evicted messages.

4. **Clean separation of agent vs. quick chats** — Memory is opt-in per chat type. Most frameworks assume all conversations should be memorized.

5. **Daily synthesis with summaries** — The consolidation→decay→purge→summarize→persona-suggest pipeline is more comprehensive than most. CrewAI and Mem0 handle dedup on write but don't have a scheduled synthesis pass.

6. **Simple, debuggable scoring** — The composite score is transparent and tunable. Compared to Zep's 5-stage reranking pipeline, it's much easier to reason about.

---

## Weaknesses / Gaps

1. **No relational/graph memory** — The biggest gap. Zep (Graphiti), Mem0^g, and Cognee all use knowledge graphs to capture *relationships* between entities. The system stores isolated facts. If a user says "My wife Sarah works at Google" and later "Sarah got promoted," these are two separate memories with no explicit link. Graph systems would connect User→married_to→Sarah→works_at→Google and update the relationship.

2. **No temporal reasoning** — Zep's bi-temporal model tracks when facts were true vs. when they entered the system. This system has `createdAt` and `lastAccessed` but can't answer "what did the user prefer *before* they changed their mind?" Old facts get overwritten or decayed away.

3. **No contradiction detection** — Mem0 and Zep explicitly detect when new information contradicts existing memories (LLM-based comparison). Dedup only checks cosine similarity — if a user changes preferences, the old memory might persist alongside the new one if they're worded differently enough (cosine < 0.85).

4. **Retrieval is single-strategy** — KNN + re-rank is solid but basic. Zep combines cosine similarity, BM25 full-text search, graph traversal, and multiple rerankers. CrewAI has adaptive-depth retrieval (shallow vs. deep depending on confidence). The system might miss memories that are semantically related but use different vocabulary.

5. **No episodic memory** — Facts are extracted but full interaction episodes aren't stored. Zep's episodic layer preserves raw data non-lossily. This means queries like "remember that conversation where we debugged the auth issue" can't be answered — only the extracted facts survive.

6. **Agent doesn't control its own memory architecture** — In MemGPT, the agent decides what to remember, where to store it, and when to archive. The agent has tools (`save_memory`, `search_memory`) but extraction is automatic and the agent can't manage its own context window or decide memory tiering. This limits the agent's autonomy.

7. **No keyword/full-text search fallback** — Pure vector search can miss exact matches. If a user asks "what do you remember about Project Atlas?", BM25/full-text would nail it, but embedding similarity might not if the project name isn't well-represented in embedding space.

8. **Limited context injection** — Top 5 memories from last 3 messages is fairly narrow. If a conversation shifts topics, relevant older memories might not surface. Some systems (LangMem, Zep) use more sophisticated context-building that considers conversation trajectory.

---

## Recommendations

| Priority | Improvement | Effort | Impact |
|----------|------------|--------|--------|
| High | **Hybrid search** — add FTS5 full-text search alongside vector KNN, combine scores | Low | Catches keyword matches vectors miss |
| High | **Contradiction detection** — when dedup finds similarity 0.6-0.85, use LLM to check if it's a contradiction vs. a related-but-different fact | Medium | Prevents stale preferences |
| Medium | **Entity extraction** — tag memories with entities (people, projects, tools), enable entity-scoped queries | Medium | First step toward relational memory |
| Medium | **Episodic summaries** — store per-conversation summaries as a separate memory type | Low | Enables "remember that conversation" queries |
| Low | **Agent memory autonomy** — let the agent decide extraction importance/skip rather than always auto-extracting | Medium | Reduces noise, increases agent agency |
| Low | **Graph layer** — Neo4j or in-SQLite graph for entity relationships | High | Full relational reasoning |

---

## Comparison with Major Systems

### MemGPT / Letta

- **Architecture**: OS-inspired three-tier — Core Memory (in-context, like RAM), Recall Memory (conversation history DB), Archival Memory (vector DB for long-term)
- **Storage**: Core serialized in agent state; recall in DB; archival in vector DB
- **Key feature**: Agent self-manages memory via tools (`core_memory_append`, `core_memory_replace`, `archival_memory_insert`, etc.)
- **Context management**: Warning at 70% capacity, auto-flush at 100% (evicts ~50% oldest messages, replaces with recursive summary)
- **Dedup**: Relies on LLM judgment
- **Strengths**: Elegant OS abstraction; full agent autonomy over memory

### LangChain / LangGraph + LangMem

- **Architecture**: Modular — short-term (thread-scoped checkpointers) + long-term (LangMem SDK with semantic, episodic, procedural memory types)
- **Storage**: Pluggable backends (Pinecone, Chroma, Weaviate, Milvus, MongoDB)
- **Key feature**: Two memory formation paths — active (hot, during conversation) and subconscious (background post-interaction)
- **Dedup**: LLM reconciliation — deleting, invalidating, updating, or consolidating
- **Strengths**: Highly composable; three cognitively-inspired memory types; framework-agnostic stores

### CrewAI

- **Architecture**: Unified `Memory` class with hierarchical scope (filesystem-like tree). Four types: short-term, long-term, entity, contextual
- **Storage**: Default LanceDB; non-blocking saves with background thread encoding
- **Scoring**: `semantic_weight * similarity + recency_weight * decay + importance_weight * importance` (defaults: 0.5/0.3/0.2, 30-day half-life)
- **Retrieval**: Adaptive-depth RecallFlow — shallow (direct vector, ~200ms) or deep (multi-step with query analysis, parallel search, recursive exploration)
- **Dedup**: Cosine > 0.85 → LLM decides keep/update/delete; cosine >= 0.98 → silently dropped
- **Strengths**: Transparent scoring; adaptive-depth retrieval; hierarchical scoping

### Mem0

- **Architecture**: Hybrid — vector DB + graph DB (Neo4j) + key-value stores
- **Extraction**: Processes conversation pairs with rolling summary context + last 10 messages
- **Update**: Each fact compared to top 10 similar existing memories; LLM decides ADD/UPDATE/DELETE/NOOP
- **Graph variant (Mem0^g)**: Entities as nodes, relationships as directed labeled edges, LLM-based conflict detection
- **Performance**: 26% higher accuracy than OpenAI memory; p50 search 0.148s, p95 0.200s; 90%+ token savings vs. full-context
- **Strengths**: Hybrid vector+graph; production-proven; clean extraction/update pipeline

### Zep (Graphiti)

- **Architecture**: Temporal knowledge graph — episodic layer (raw data), semantic entity subgraph, community layer (cluster summaries)
- **Temporal model**: Bi-temporal — `t_valid`/`t_invalid` (when facts were true) + `t'_created`/`t'_expired` (when facts entered system)
- **Extraction**: Entity extraction → entity resolution → fact extraction → fact dedup → edge invalidation
- **Retrieval**: Three stages — search (cosine + BM25 + BFS graph traversal) → rerank (RRF, MMR, 3 other rerankers) → construct
- **Performance**: 71.2% accuracy on LongMemEval (vs 60.2% full-context baseline); context reduction from 115K to ~1,600 tokens
- **Strengths**: Most sophisticated temporal reasoning; non-lossy episodic layer; multi-strategy reranking; graph-based relational reasoning

### Cognee

- **Architecture**: ECL pipeline (Extract, Cognify, Load) with graph store (Kuzu) + vector store (LanceDB) + relational store (SQLite)
- **Key feature — Memify**: Post-ingestion refinement that prunes stale nodes, strengthens frequent connections, reweights edges, adds derived facts. Memory self-improves over time
- **Retrieval**: 14 modes including GRAPH_COMPLETION (vector search as hint → graph triplets → traversal)
- **Strengths**: Self-improving memory; 38+ format ingestion; 14 retrieval modes; fully local deployment possible

---

## Bottom Line

The system is solid — on par with Mem0's core architecture and ahead of basic LangChain memory types. The persona evolution and synthesis pipeline are genuinely distinctive features. The main gap versus state-of-the-art (Zep/Graphiti, Cognee) is the lack of relational/graph memory and temporal reasoning.
