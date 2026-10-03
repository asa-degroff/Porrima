# Memory System

The memory system has two complementary layers:
- **Atomic memories** — individual facts extracted from conversations (this document)
- **Memory blocks** — structured knowledge documents curated by the agent (see [memory-blocks.md](memory-blocks.md))

## Categories (8 types)

- `preference` — user likes, dislikes, stylistic choices
- `fact` — concrete information about the user or their world
- `behavior` — observed patterns in how the user works or communicates
- `instruction` — explicit directives from the user
- `context` — project-level information: architecture, tech choices, ongoing work
- `decision` — choices made and why, tradeoffs considered
- `note` — general observations, curiosities, personal details
- `reflection` — higher-order insights, cross-session patterns, agent self-reflection. A first-class category like any other (any extraction run may emit it), but synthesis Phase 3 is the only place the system *asks* for them: `save_memory(category='reflection', importance=7-9)`. Nothing enforces that convention.

Invalid or missing categories fall back differently depending on the caller: extraction substitutes `note` and logs a warning, while the `save_memory` tool substitutes `fact`. Expect a `note` where you predicted a `fact`.

## Project Scoping

Memories have an optional `projectId` field for project-scoped context. The DB auto-migrates the `project_id` column.

## Source Tracking

`sourceType` is one of `'chat' | 'chat_delayed' | 'chat_immediate' | 'explicit' | 'synthesis' | 'consolidation'`. In practice only `chat_immediate`, `chat_delayed`, and `explicit` are ever written — synthesis-phase `save_memory` calls are recorded as `explicit`, and `consolidation` is reserved for an unimplemented durability phase.

Supersession is **not** a sourceType. It is a `superseded_by` / `supersedes` pointer pair plus a `memory_supersession_history` audit row, so row provenance and lineage stay separate concerns.

## Extraction

- **Immediate extraction**: after each agent response, a background LLM call extracts memories (1-3 sentences each with context and rationale) and deduplicates them against existing memories using cosine similarity **gated on word-level text overlap**: an exact normalized match, or similarity ≥ 0.985 with overlap ≥ 0.75, or similarity ≥ 0.95 with overlap ≥ 0.82. On a match the existing row is kept and its `importance` bumped to the max and its `durability` merged (session → durable only) — no text is rewritten. (0.85 is *not* the dedup threshold; see the `computeNovelty` / clustering notes in [key-patterns.md](key-patterns.md).) Extraction is **deferred** until after the agent loop completes to prevent concurrent LLM calls from interfering with the active tool loop (e.g., triggering model reloads on llama.cpp).
- **Delayed extraction**: time-based trigger (configurable threshold, default 30 min) runs on inactive chats. Two-phase pipeline:
  1. **Extract** — sends the full conversation context with previously-extracted memories injected for deduplication, focusing on new patterns/decisions that immediate extraction missed. Uses `extractInChunks()` — single call when content fits, chunked with 500-char overlap when it doesn't.
  2. **Compare** — for each new fact, finds similar existing memories in the supersession candidate band (embedding similarity 0.90–0.95, top 5 per fact). Ambiguous pairs are sent to the LLM for batch judgment. **Warm continuation**: when extraction was a single chunk and fits the context budget, the comparison reuses the extraction KV cache — the dialogue is `[user: extraction prompt, assistant: extraction output, user: comparison prompt]`, so only the comparison prompt needs decoding. Falls back to a **cold comparison** (fresh prompt with truncated conversation context) if extraction was chunked or the warm dialogue exceeds budget. Comparison uses its own capped `max_tokens` (800–4000, scaled by candidate count) to prevent long decodes. Resolutions are index-based, allowing one new memory to supersede at most one old memory.
  - Tracks `lastDelayedExtractionAt` and `lastDelayedExtractionMessageIndex` per chat. Uses `updateChatExtractionState()` to avoid touching `lastModified` (preserves chat ordering).
- **Pre-compaction flush**: when conversation context is compacted, memories are extracted from the removed messages before archival. Compaction summary messages (`_isCompactionSummary`), out-of-context rows, system rows, and synthesis rows (`_isSynthesisMessage`) are filtered out to prevent extracting operational metadata or the synthesis cycle's own review of already-extracted memory content. There is **no bypass** — the flush runs on every compaction; it shares one extraction session with any mid-turn pulses, so it continues from their cached prefix rather than re-evaluating cold.

- **Mid-turn pulse** (`maybeDispatchMidTurnPulse` in `routes/chat.ts`): fires during long tool loops, either when uncovered signal text exceeds `MID_TURN_PULSE_MIN_SIGNAL_TOKENS` (256) or when estimated context usage crosses `DEFAULT_MID_TURN_EXTRACTION_CONTEXT_RATIO` (0.65). The pressure trigger carries a **+0.05 step latch** that re-arms only when the ratio falls back out of the zone — without it, a single tool round-trip trivially exceeds 256 tokens and the whole 0.65–0.85 band would fire at nearly every iteration boundary, each costing a 4B CPU extraction call plus a session dialogue pair that prunes and re-prefills at the 8-pair cap. The signal window is **cursor-derived** (offsets into `fullText` / `thinkingText` / `allToolCalls` / `allToolResults`), not a counter, so a failed or timed-out pulse rolls its cursors back and the same content is retried. `extractionMidTurnTimeoutMs` defaults to **120000** (2 min), range 15000–900000; the upper bound must stay in sync with the Settings modal cap.

### Editable extraction prompt

The extraction system prompt's user-editable prefix lives at `~/.porrima/extraction-prompt.md` and is editable in Settings → Extraction via `PUT /api/extraction-prompt`. `DEFAULT_EXTRACTION_PREFIX` seeds it on first run; the *task instructions* are assembled at runtime around the prefix and are not editable. Every save snapshots the prior content to `~/.porrima/extraction-prompt-history/extraction-prompt-<ts>.md` and appends a `CHANGELOG.md` entry with the supplied reason; list and read versions via `/api/extraction-prompt/history`. (The history endpoints have no client UI yet.)

### Durability scoping (session vs durable)

Every extracted memory carries a `durability` label, orthogonal to category and importance:

- `session` — only useful while its origin thread is active: current step, open branches, mid-experiment values, next actions, pending decisions.
- `durable` — still useful outside the thread: settled decisions, architecture facts, preferences, instructions, lessons, project relationships.

All extraction prompts (immediate, mid-turn pulse, pre-compaction, delayed) classify each fact; missing or invalid labels fall back to `durable`. When a re-saved duplicate is labeled durable, the stored session memory is promoted — durability only ever moves session → durable. Legacy rows default to durable.

The label is currently informational (extraction, storage, tools, debug panel). Retrieval policy — dampening cross-chat session memories during ranking — is planned as a follow-up; see [design/memory-durability.md](design/memory-durability.md).

## Retrieval Pipeline

Memory retrieval uses a multi-stage pipeline for high-relevance results:

### Retrieval depth profiles (`retrieval-settings.ts`)

Every tunable below is driven by `resolveRetrievalBudget(settings)`, which resolves `settings.retrievalDepthProfile` — one of `fast`, `balanced` (default), `thorough`, or `custom` — into a concrete `RetrievalBudget`. `custom` starts from the `balanced` preset and is then overridden field-by-field by the individual `settings` values, each clamped to a safe range. The reranker timeout (`rerankerTimeoutMs`, default 25s) is part of the same budget.

| Profile | `memoryContext.searchQueryChars` | `searchLimit` | `candidatePool` | `rerankTopN` | `passiveRecall.queryChars` | `passiveRecall.rerankTopN` | `memoriesPerInjection` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fast` | 4000 | 24 | 18 | 12 | 4000 | 3 | 1 |
| `balanced` (default) | 6000 | 30 | 24 | 18 | 6000 | 4 | 2 |
| `thorough` | 8000 | 48 | 36 | 24 | 8000 | 6 | 3 |

Each profile also sets `rerankQueryChars`, `rerankDocumentLimit`, `rerankDocumentChars`, and `diverseCandidateLimit`. The numbers quoted in the rest of this document are the `balanced` defaults.

`custom` values are clamped field-by-field:

| Field | Range | Notes |
| --- | --- | --- |
| `rerankerTimeoutMs` | 5 000 – 60 000 | |
| `memoryContext.searchQueryChars` | 2 000 – 12 000 | |
| `memoryContext.rerankQueryChars` | 400 – 2 000 | |
| `memoryContext.searchLimit` | 12 – 80 | |
| `memoryContext.rerankDocumentLimit` | 8 – 40 | |
| `memoryContext.candidatePool` | `rerankDocumentLimit` – 80 | **coupled** |
| `memoryContext.rerankTopN` | 4 – `rerankDocumentLimit` | **coupled** |
| `passiveRecall.queryChars` | 2 000 – 12 000 | |
| `passiveRecall.rerankQueryChars` | 400 – 3 000 | |
| `passiveRecall.searchLimit` | 12 – 96 | |
| `passiveRecall.rerankDocumentLimit` | 8 – 32 | |
| `passiveRecall.candidatePool` | `rerankDocumentLimit` – 96 | **coupled** |
| `passiveRecall.diverseCandidateLimit` | `rerankDocumentLimit` – 48 | **coupled** |
| `passiveRecall.rerankDocumentChars` | 400 – 4 000 | |
| `passiveRecall.rerankTopN` | 2 – `rerankDocumentLimit` | **coupled** |
| `passiveRecall.memoriesPerInjection` | 1 – 5 | |

The coupling is surprising and worth knowing before editing Settings: `candidatePool`, `rerankTopN`, and `diverseCandidateLimit` cannot be set *below* their corresponding `rerankDocumentLimit`, so raising the document limit raises their floors too.

### Stages

1. **Hybrid search** (`memory-storage.ts`): Vector search (qwen3-embedding:0.6b) + FTS5 full-text search, fused via RRF (Reciprocal Rank Fusion, K=60), with a candidate pool sized by the budget. Post-scoring applies recency decay (30-day half-life), importance weight, and supersession penalty.

2. **Cross-encoder reranking** (`reranker.ts`): Top candidates are reranked by Qwen3-Reranker-0.6B (dedicated CPU instance on port 32102) using source-specific instructions:
   - **Agent**: "judge whether this memory is relevant to the user's current task, question, or topic of discussion"
   - **Passive-memory**: instruction tuned for mid-turn context discovery during long agent runs
   - Graceful fallback to RRF-only scoring if reranker is unavailable (main retrieval only — passive recall bails entirely if reranker is down)

3. **MMR diversity selection** (`memory-context.ts`): MMR runs **twice** in main retrieval — λ = 0.65 to trim the candidate pool before it is handed to the cross-encoder, then λ = 0.7 over the reranked survivors. Passive recall uses λ = 0.55 (more diversity-biased) since it accumulates candidates across multiple search rounds.

4. **Topic-aware culling** (`memory-context.ts`): once an in-context compaction summary exists, the most recent one is embedded as a topic anchor and every reranked score is multiplied by `0.3 + 0.7 * topicSim`. Off-topic memories stay reachable but are significantly disadvantaged. This is inactive before the first compaction, and it is what makes post-compaction retrieval topic-coherent rather than accumulating every topic the chat ever touched.

5. **Project scoping** (`memory-retrieval-scope.ts`): memories are shaped by score multipliers, applied both inside `searchMemories` and again post-rerank. A project chat dampens other projects' memories by a configurable multiplier (default **0.3**); global and system chats use a separate multiplier (default **1.0**), which is why no-project chats are neutral toward project-scoped memories by default while still being tunable toward a more global focus. `sortByAdjustedScore()` is the canonical "apply then re-rank" step. (Despite the name, this module holds only the project multipliers — the session-scope policy specified in the durability design is Phase 2 and is *not* in this file yet.)

6. **Context injection** (`memory-context.ts`, `passive-memory-recall.ts`): up to `rerankTopN` results come back from the cross-encoder; those are MMR-filtered at λ = 0.7 and capped at **15 current** (score > 0.05) plus **5 superseded** (score > 0.02) for injection into the stable context on first turn/post-compaction. `rerankTopN` and the injection cap are separate knobs — under the `fast` profile `rerankTopN` is 12, so the budget can bind first. Later retrievals use delta or passive recall messages so the base system prompt stays byte-identical. Each injected line carries its memory id, which is load-bearing: it is the agent's only way to target `save_memory(supersedeMemoryId=...)` or `search_conversation(memory_id=...)`.

**Retrieval logging**: Each retrieval logs query preview, reranker model/fallback status, latency, score distribution (min/max/median), threshold crossings, and top memory previews for tuning.

## KV Cache Optimization (Delta-Based Memory Injection)

To maximize KV cache hit rates with llama.cpp's longest-common-prefix caching, memory augmentation uses a delta-based strategy:

**Architecture:**
- **Frozen memories**: On first turn or after compaction, retrieved memories are baked into the system prompt
- **Delta injection**: When new memories are extracted, only NEW memories (not already in context) are injected as a small message at the end of conversation history, just before the new user message
- **Cache preservation**: This keeps the system prompt byte-identical between turns, preserving the KV cache for the stable prefix (system prompt + persona + user doc + blocks + AGENTS.md + frozen memories + conversation history)

**State tracking:**
- `MemoryContextState` per chat tracks `frozenIds` (memories in system prompt) and `deltaIds` (memories injected via deltas)
- `dirty` flag triggers re-retrieval when new memories are extracted
- On retrieval, only memories not in `frozenIds ∪ deltaIds` are included in the delta

**Invalidation points:**
- `invalidateMemoriesCache(chatId)` — marks dirty after extraction, so the next turn takes the delta path. Falls through to a durable write if the in-memory Map has no entry yet, so a post-restart invalidation before first hydration is not lost
- `invalidateAllMemoriesCaches()` — marks every cached chat dirty *and* issues a bulk `UPDATE` so a corpus-wide change after a restart still lands on chats that have never been hydrated
- `softResetMemoryContext(chatId)` — **the post-compaction path.** Keeps `frozenIds` and the frozen section byte-exact, clears `deltaIds`, and sets `dirty` so the next build is a Case 3 delta. Re-rolling the frozen set at compaction was pure nondeterminism (a 5 → 4 → 0 → 3 sequence was observed in one night) that broke the prefix at the section boundary and manufactured a pool orphan each time
- `resetMemoryContext(chatId)` — hard reset (in-memory Map *and* the durable row), used only where a re-roll is genuinely owed: chat deletion, zeitgeist rewrites, automation starts, and workspace changes

**Error handling:**
- If delta retrieval throws, `dirty` deliberately stays `true` so the next turn retries with a different query string. The frozen section is preserved in the meantime, so a failure is prefix-safe either way
- `dirty` is cleared only on a *successful* delta build (or on a successful freeze)

**Logging:**
- `[kv-cache]` logs show system_prompt size, delta size, new message size, and turn type (stable/delta)
- Correlate with llama.cpp prompt eval stats to verify cache efficiency

**Key insight:** The tradeoff of adding delta messages to conversation history (~200-500 tokens) is minimal compared to reprocessing the entire context (potentially thousands of tokens) when the system prompt changes.

See `memory-context.ts` for implementation details: `buildSplitAugmentedPrompt()` returns `systemPrompt` (frozen), `memoriesMessage` (delta), and `newMemoryIds`; a caller that puts the delta on the wire commits the ids with `commitMemoryDelta()` after its save.

## Passive Mid-Turn Memory Recall

Long-running agent turns can retrieve memories without waiting for the next user message. `PassiveMemoryRecallController` (in `passive-memory-recall.ts`) runs from the HTTP chat loop and headless automation runner via two scheduling paths:

**Two scheduling paths:**

- **Tool-use path (mid-turn):** Schedules after each `stopReason === "toolUse"` event. Spaced every 2 iterations (`SEARCH_EVERY_ITERATIONS`) to avoid redundant searches during rapid tool loops. Memories land in a `readyQueue` and are injected via `peekReady()` before the next provider call, gated by a 3-iteration minimum between injections (`MIN_ITERATIONS_BETWEEN_INJECTIONS`).
- **Conversational stop path (post-turn):** Schedules after `stopReason === "stop"`. Requires meaningful depth — the latest assistant message must have thinking ≥ 150 chars or content ≥ 300 chars — to avoid wasting searches on trivial one-line responses. Bypasses the readyQueue entirely, calling the `onReady` persist callback directly. The persisted row gets `_mergeIntoNextUserMessage: true` so it merges into the next user message on replay rather than sitting as a standalone row.

**Two-query architecture:**

- **Search query** (`buildPassiveRecallQuery`): Wide net. It first slices to the **active turn** — everything from the latest user message onward — then takes the most recent 12 non-system, non-out-of-context messages from that window, always pinning the originating request so the task anchor survives a long tool loop. For each: thinking (up to 800 chars, tail-clamped), content (up to 1000 chars, 1600 for compaction summaries), user messages (up to 1200 chars), plus extracted tool-call signal. Capped at 6000 chars by default (`passiveRecall.queryChars`). Minimum 80 chars required to fire.
- **Rerank query** (`buildPassiveRerankQuery`): Tight focus on the latest assistant message only — the agent's current trajectory. Budget allocation: thinking 35%, tool-call signal 25%, assistant content 25%, user request with decay (45% when no trajectory exists, drops to 15% once combined trajectory length ≥ 200 chars). Capped at ~900 chars.

**Tool-call signal extraction:** `extractToolCallSignal()` extracts semantic arguments from tool calls (`query`, `path`, `blockId`, etc.) — the agent's *intent*, not its output. Raw tool results are intentionally excluded (noisy). File paths and URLs are scrubbed to topic words via `anchorToTopicWords()` (e.g., `server/src/services/passive-memory-recall.ts` → `passive memory recall`).

**Operational noise scrubbing:** `scrubOperationalNoise()` strips code blocks, tool call XML, tool/command names, file paths, API endpoints, and `path=`/`file=` key-value pairs from all query text. Cross-encoders are sensitive to distributional shift — operational anchors that dominate the query surface cause the reranker to over-weight structurally similar but topically irrelevant memories.

**Search pipeline with candidate accumulation:**

1. Embed the search query. Run hybrid vector + FTS5 search with cross-project score dampening. The vector leg oversamples `topK` by 8× when a project scope policy is active and 3× otherwise, so project chats build a wider candidate pool before reranking.
2. Span filter: removes same-chat memories whose source messages are ≥ 80% visible in context.
3. Exclude: frozen IDs, delta IDs, already-injected IDs, already-queued IDs, superseded memories, and **same-turn memories** — anything extracted during the current `turnId` is dropped, so passive recall never feeds the agent its own fresh output.
4. MMR diversity selection (λ = 0.55, more diversity-biased than main retrieval's λ = 0.7).
5. **Accumulate** candidates in a shared map. Unlike main retrieval (one-shot), passive recall can search multiple times per turn — each round improves candidate scores if it finds something better.
6. Cross-encoder rerank fires only after `MIN_CANDIDATES_BEFORE_RERANK` (3) candidates accumulate. Uses the `passive-memory` specific reranker instruction.
7. **Precision-over-recall:** If the reranker model is unavailable, passive recall bails entirely (no fallback to vector scores). The `MIN_RERANK_SCORE` threshold is 0.12 — higher than main retrieval's 0.05 floor.
8. Final selection is capped at `memoriesPerInjection` from the budget.

**Gating:**
- Query hash dedup: skips search if the query content hasn't changed since the last round.
- In-flight guard: only one search runs concurrently per chat.
- **No per-turn cap.** Volume is bounded by the spacing guards, the query-hash dedup, the `MIN_RERANK_SCORE` floor, `memoriesPerInjection`, and the per-chat dedup sets — deliberately, so a long autonomous run keeps receiving recall across compactions. (An earlier `memoriesPerTurn` / `totalInjected` budget was removed.)
- Iteration spacing: 3 iterations minimum between injections (tool-use path only; post-turn bypasses this).

**Injection flow:**
- Mid-turn: `peekReady(iteration)` → if ready, persist assistant boundary, push hidden system row, convert to synthetic user message via `toReplayUserMessage()`, push to agent messages, then call `markApplied()`.
- Post-turn: `onReady(content, memoryIds)` callback pushes the system row directly to `chat.messages` and persists.

**Mark-after-persist ordering.** `markApplied()` is in-memory bookkeeping only — it moves IDs from queued to injected and records the injection iteration. The *durable* write to `memory_context_state.delta_ids` happens in `markPersisted()`, and it is called **only after `persist.onReady` resolves**, i.e. after `saveChat` has actually landed the row. Marking at injection time loses a delivery the wire never made; marking after persist risks only a possible duplicate. A turn that dies in between therefore leaves the IDs unmarked, which is the correct failure direction.

Passive recalls preserve the same replay constraints as normal memory deltas. The persisted chat row is hidden as `role: "system"` with `_isPassiveMemoryRecall` for storage/UI filtering, but the live agent context receives the replay-equivalent synthetic `user` message. `chatMessagesToPiMessages()` reconstructs that same synthetic user message from the hidden row on follow-up turns. Do not live-inject raw mid-transcript `system` messages; provider templates normalize or reject them, and replay must remain byte-compatible with the prompt shape the model already saw.

In headless automation turns (`chat-turn-runner.ts`), the search context includes transient in-memory assistant/tool activity appended to persisted messages. The runner persists an assistant boundary before storing the hidden recall row so replay keeps the same order as the live transcript.

## Memory Graph (`memory-graph.ts`)

Beyond pairwise retrieval, the system maintains an explicit similarity graph over memories so the client can visualise relationships and inspect neighbours the agent never asked for. **It is a read-only analysis surface** — no retrieval path and no agent tool traverses it. Edges are pure nearest-neighbour cosine (thresholded, then top-k per source); there is no multi-hop expansion and no recency, importance, or durability term in a semantic edge's score. Clusters are plain connected-components over the semantic subgraph, so lineage links do not merge them.

- **Defaults**: `minSimilarity` 0.9, `neighbors` 6, `limit` 500 (capped at 2500).
- **Edge building has two paths**, chosen by size and reported in `stats.edgeSource`:
  - ≤ 500 embedded nodes: brute-force O(n²) pairwise cosine, deduped by unordered id pair, rounded to 4dp. `edgeSource: "pairwise"`.
  - \> 500: the `memory_graph_edges` cache is backfilled for just the requested IDs and read back (48 neighbours stored per source, narrowed to `neighbors`). Reported as `"cache"` at ≥ 0.95 coverage, else `"hybrid"`, falling back to pairwise if the cache yields nothing.
- **Focused mode**: supplying both `query` and `queryEmbedding` selects the node set via RRF fusion (K=60) of three candidate sources — vector KNN (weight 1.0), FTS5 (0.85), and a metadata LIKE over category / project / source type (0.65) — capped at 4000 candidates, then re-sorted by fused score with importance and recency as tiebreakers. `stats.mode` reports `"focused"` vs `"overview"`.
- **Link types**: `semantic` (the cosine edges above) and `lineage` (supersession, similarity hard-coded to 1, only between nodes present in the returned subgraph). Together they show topical *and* temporal structure.
- **Surfaces**: `GET /api/memory/graph`, plus `GET /api/memory/timeline` (time-ranged, optionally grouped) and `GET /api/memory/contradictions` (heuristically grouped topic clusters that may conflict). Rendered client-side by `MemoryGraphView.tsx`.

## Supersession

Retiring a fact is a first-class operation rather than a delete, so the reasoning survives. There are **three** edge-creation paths:

1. **Agent-initiated**, confidence 1.0, no LLM gate — `save_memory(supersedeMemoryId=...)`. The target must exist and not already be superseded, and the agent may only target the first fact of a multi-fact extraction. This is the path the agent is actively instructed to prefer.
2. **Delayed-extraction compare**, LLM-judged — see the 0.90–0.95 band below.
3. **Manual** — `POST /api/memory/:id/supersede`.

- The two thresholds do different jobs: **0.90** (`SUPERSESSION_CANDIDATE_THRESHOLD`) is the KNN *fetch* floor — below it a pair is never considered. **0.95** (`EXACT_DUPLICATE_THRESHOLD`) is the near-duplicate *merge* cutoff — at or above it the new fact isn't saved at all. The "0.90–0.95 band" is the interval in which a pair is a candidate: fetch at ≥ 0.90, avoid classifying as duplicate below 0.95. Candidates are skipped if already superseded, created during the current run, or caught by `isNearDuplicate`. All candidates across all facts go to the extraction model in **one batch**, and `linkedNewMemoryIds` enforces at most one old memory per new memory.
- A memory carries `superseded_by` / `supersedes` pointers; the `memory_supersession_history` table records `older_memory_id`, `newer_memory_id`, `confidence`, and — importantly — nullable `removed_at` / `removal_reason`, so a *retracted* supersession is recoverable rather than lost. `createSupersessionLink` rejects self-links and cycles, walking the chain forward from the newer and backward from the older.
- `POST /api/memory/backfill-supersessions` is a retained **no-op**: heuristic backfill is disabled and the route returns that message. Delayed extraction performs LLM-reviewed linking instead. `GET /api/memory/:id/lineage` walks a single memory's chain; `DELETE /api/memory/:id/supersession` removes one edge.
- Superseded memories are still injected (capped at 5 alongside current ones) so the agent can see what a fact replaced.

## Agent Tools

Memory-facing tools live in `memory-tools.ts` and are merged into the registry in `agent-tools.ts`:

- `save_memory` — store a new memory (optional `durability`: `durable` or `session`, default `durable`)
- `search_memory` — vector + FTS5 search across all memories
- `update_memory` — edit an existing memory in place
- `create_memory_block` / `update_memory_block` / `read_memory_block` / `list_memory_blocks` — structured knowledge documents (see [memory-blocks.md](memory-blocks.md))
- `create_notebook_entry` — write an agent notebook entry (this is the agent's responsibility during synthesis, not something the server does for it)
- `search_conversation` — FTS5 search across current messages AND archived context blocks (cross-chat)
- `read_archived_context` — dereference an archive block ID to retrieve full original messages (tool outputs, code, reasoning)

There is no `forget_memory` tool. Memories are retired by supersession (`POST /api/memory/:id/supersede`) or by direct deletion; block revision history is HTTP-only (`GET /api/memory/blocks/:id/history`).

## Indexed Compaction & Context Archives

When compaction runs, removed messages are preserved as full-fidelity archives rather than discarded:

- Messages are grouped into logical blocks (tool call+result pairs, user+assistant exchanges)
- Archived in `context_archives` table with FTS5 indexing for cross-chat search
- An LLM generates one-line descriptions for each block
- The indexed summary replaces removed messages in the chat
- Archives are globally searchable — an investigation from one chat surfaces in another chat's `search_conversation` results

This separates two complementary retrieval needs:
- **Memories** (existing): distill generalizable knowledge across conversations
- **Archives** (new): preserve specific artifacts (exact tool outputs, code, reasoning) for precise retrieval

## Synthesis (`system-chat.ts`)

Synthesis runs the main model inside a persistent **system chat** (`chat.type === "system"`, id `"system"`). Each cycle, the server:

1. **Pre-archives** recent unarchived agent chats via `pre-synthesis-archive.ts` — creates `context_archives` rows with LLM-generated one-line `indexEntry` descriptions so the synthesis agent can pull full transcripts via `read_archived_context`.
2. **Builds a synthesis trigger** — a single user-role `ChatMessage` containing: archive index entries grouped by chat, memories written since the last synthesis (delta-based, not importance-based; fallback to last 24h on first run; capped at 50), recent notebook entries. Persona, user doc, memory blocks, and zeitgeist are injected via the stable system-prompt prefix instead, not the trigger body — keeps them byte-identical across cycles for KV caching.
3. **Appends the trigger** to the persistent system chat and runs pre-send compaction before dispatch so the system chat stays within context before the model begins prefill.
4. **Composes the system prompt** from the stable prefix only: `chat.systemPrompt` → `buildStablePrefix(...)` (persona + user doc + global memory blocks + zeitgeist + optional project context/blocks). Phase instructions live in user-role trigger/follow-up messages, so editing automation prompts does not invalidate the system chat's longest-common-prefix KV cache.
5. **Runs the shared headless tool loop** via `runHeadlessChatTurn()` / `runAgentLoop()` with the full system tool suite except `ask_user`. Later synthesis phases are injected through `getFollowUp` after turn boundaries.
6. **Persists output** — writes the assistant response to the system chat (with `_isSystemMessage`, `_isSynthesisMessage`, and automation metadata when present). Notebook persistence is the agent's responsibility through the `create_notebook_entry` tool; the server warns if synthesis text is produced without a notebook tool call.
7. **Warms prompt caches** — dispatched by the **automation runner** (`automation-runner.ts`) after `runSystemSynthesis()` returns, not by `system-chat.ts`. A manual `POST /api/memory/synthesis/run` dispatches synthesis directly and therefore does **not** warm anything. The warm queue reads llama.cpp capacity from `/props.max_instances` (falling back to the configured inference `parallel`) and builds a prioritized plan: synthetic new-agent-chat baseline first, system chat second, then recent agent chats. Execution order is deliberately *reversed* — recent chats first, baseline **last** — so `--kv-unified` longest-prefix selection leaves the baseline as the most-recently-touched entry, which is what a brand-new global chat will select.
8. **Marks the cycle** — calls `setLastSynthesis(now)` only after a successful run so failed/no-output runs can retry on a later automation tick.

Synthesis owns both the daily narrative (notebook entry) and zeitgeist maintenance (the agent calls `update_memory_block` on the zeitgeist block when the continuity narrative has shifted). See [zeitgeist.md](zeitgeist.md).

**Triggers:**
- Scheduler: the built-in automation `builtin:synthesis` is checked by `automation-scheduler.ts` every 5 minutes and defaults to a 24-hour interval. It is ordered with other automations, skipped while user chat/automation/cache-warm work is active, requires a short idle grace after foreground user interaction, and respects the sleep-mode cooldown.
- Manual automation: `POST /api/automations/builtin%3Asynthesis/run` dispatches the built-in task and records an `automation_runs` row.
- Legacy/manual memory endpoints: `POST /api/memory/synthesis/run` and `POST /api/memory/synthesis/sleep` still dispatch synthesis asynchronously (202 Accepted) and return immediately. Clients poll `/api/memory/synthesis/status` (which exposes `isSynthesizing`) to observe progress. `/sleep` stamps `settings.sleepModeTriggeredAt` so periodic synthesis is suppressed for 2 hours.

**Synthesis lock:** `system-chat.ts` exports `acquireSynthesisLock` / `releaseSynthesisLock` / `getSynthesisLock` / `isSynthesisActive`. The chat route waits on `getSynthesisLock()` before processing a user message, so synthesis and user chat are strictly serialized on the main model. Enrichment and delayed-extraction checks in the scheduler also skip while synthesis is active.

**Automation lock:** scheduled and manual automation runs also use `automation-lock.ts` so built-in synthesis, wake cycles, and custom automations cannot overlap each other.

**Reflections:** `reflection` memories (importance 7–9) are created by the agent via `save_memory` calls during synthesis, not batch-generated post-hoc.
