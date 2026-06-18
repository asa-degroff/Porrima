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
- `reflection` — synthesis-only: higher-order insights, cross-session patterns, agent self-reflection

## Project Scoping

Memories have an optional `projectId` field for project-scoped context. The DB auto-migrates the `project_id` column.

## Source Tracking

Memories track `sourceType` ('chat_immediate', 'chat_delayed', 'synthesis', 'supersession') and `sourceId` for lineage. Supersession links (`superseded_by`, `supersedes`) track when memories are updated/contradicted.

## Extraction

- **Immediate extraction**: after each agent response, a background LLM call extracts memories (1-3 sentences each with context and rationale) and deduplicates them against existing memories using cosine similarity (>0.85 triggers UPDATE). Extraction is **deferred** until after the agent loop completes to prevent concurrent LLM calls from interfering with the active tool loop (e.g., triggering model reloads on llama.cpp).
- **Delayed extraction**: time-based trigger (configurable threshold, default 30 min) runs on inactive chats. Two-phase pipeline:
  1. **Extract** — sends the full conversation context with previously-extracted memories injected for deduplication, focusing on new patterns/decisions that immediate extraction missed. Uses `extractInChunks()` — single call when content fits, chunked with 500-char overlap when it doesn't.
  2. **Compare** — for each new fact, finds similar existing memories in the supersession candidate band (embedding similarity 0.90–0.95, top 5 per fact). Ambiguous pairs are sent to the LLM for batch judgment. **Warm continuation**: when extraction was a single chunk and fits the context budget, the comparison reuses the extraction KV cache — the dialogue is `[user: extraction prompt, assistant: extraction output, user: comparison prompt]`, so only the comparison prompt needs decoding. Falls back to a **cold comparison** (fresh prompt with truncated conversation context) if extraction was chunked or the warm dialogue exceeds budget. Comparison uses its own capped `max_tokens` (800–4000, scaled by candidate count) to prevent long decodes. Resolutions are index-based, allowing one new memory to supersede at most one old memory.
  - Tracks `lastDelayedExtractionAt` and `lastDelayedExtractionMessageIndex` per chat. Uses `updateChatExtractionState()` to avoid touching `lastModified` (preserves chat ordering).
- **Pre-compaction flush**: when conversation context is compacted, memories are extracted from the removed messages before archival. Compaction summary messages (`_isCompactionSummary`), out-of-context rows, system rows, and synthesis rows (`_isSynthesisMessage`) are filtered out to prevent extracting operational metadata or the synthesis cycle's own review of already-extracted memory content.

## Retrieval Pipeline

Memory retrieval uses a multi-stage pipeline for high-relevance results:

1. **Hybrid search** (`memory-storage.ts`): Vector search (qwen3-embedding:0.6b, 45 candidates) + FTS5 full-text search, fused via RRF (Reciprocal Rank Fusion, K=60). Post-scoring applies recency decay (30-day half-life), importance weight, and supersession penalty.

2. **Cross-encoder reranking** (`reranker.ts`): Top candidates are reranked by Qwen3-Reranker-0.6B (dedicated CPU instance on port 32102) using source-specific instructions:
   - **Agent**: "judge whether this memory is relevant to the user's current task, question, or topic of discussion"
   - **Quick**: "judge whether this memory contains information useful for responding"
   - **Passive-memory**: instruction tuned for mid-turn context discovery during long agent runs
   - Graceful fallback to RRF-only scoring if reranker is unavailable (main retrieval only — passive recall bails entirely if reranker is down)

3. **MMR diversity selection** (`memory-storage.ts`): Lambda=0.7 (70% relevance, 30% diversity) for main retrieval. Passive recall uses λ=0.55 (more diversity-biased) since it accumulates candidates across multiple search rounds.

4. **Project scoping**: Project chats dampen memories from other projects with the configurable cross-project multiplier. Global and system chats use a separate project-memory multiplier so project-scoped memories can compete equally by default, while still allowing users to make no-project chats more global-focused.

5. **Context injection** (`memory-context.ts`, `passive-memory-recall.ts`): Top 15 current + up to 5 superseded memories are injected into the stable context on first turn/post-compaction. Later retrievals use delta or passive recall messages so the base system prompt stays byte-identical.

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
- `invalidateMemoriesCache(chatId)` — sets dirty flag after extraction (triggers delta on next turn)
- `resetMemoryContext(chatId)` — full reset after compaction (rebuilds frozen set from scratch)
- `invalidateStablePrefixCache(chatId)` — when blocks or persona change

**Error handling:**
- If delta retrieval fails, the frozen system prompt is preserved (not falling back to bare base prompt)
- Dirty flag is cleared to prevent immediate retry loops

**Logging:**
- `[kv-cache]` logs show system_prompt size, delta size, new message size, and turn type (stable/delta)
- Correlate with llama.cpp prompt eval stats to verify cache efficiency

**Key insight:** The tradeoff of adding delta messages to conversation history (~200-500 tokens) is minimal compared to reprocessing the entire context (potentially thousands of tokens) when the system prompt changes.

See `memory-context.ts` for implementation details: `buildSplitAugmentedPrompt()` returns both `systemPrompt` (frozen) and `memoriesMessage` (delta).

## Passive Mid-Turn Memory Recall

Long-running agent turns can retrieve memories without waiting for the next user message. `PassiveMemoryRecallController` (in `passive-memory-recall.ts`) runs from the HTTP chat loop and headless automation runner via two scheduling paths:

**Two scheduling paths:**

- **Tool-use path (mid-turn):** Schedules after each `stopReason === "toolUse"` event. Spaced every 2 iterations (`SEARCH_EVERY_ITERATIONS`) to avoid redundant searches during rapid tool loops. Memories land in a `readyQueue` and are injected via `peekReady()` before the next provider call, gated by a 3-iteration minimum between injections (`MIN_ITERATIONS_BETWEEN_INJECTIONS`).
- **Conversational stop path (post-turn):** Schedules after `stopReason === "stop"`. Requires meaningful depth — the latest assistant message must have thinking ≥ 150 chars or content ≥ 300 chars — to avoid wasting searches on trivial one-line responses. Bypasses the readyQueue entirely, calling the `onReady` persist callback directly. The persisted row gets `_mergeIntoNextUserMessage: true` so it merges into the next user message on replay rather than sitting as a standalone row.

**Two-query architecture:**

- **Search query** (`buildPassiveRecallQuery`): Wide net. Takes the last 12 non-system, non-out-of-context messages. For each: thinking (up to 800 chars), content (up to 1000 chars, 1600 for compaction summaries), user messages (up to 1200 chars), plus extracted tool-call signal. Capped at 6000 chars by default (configurable via retrieval budget `passiveRecall.queryChars`). Minimum 80 chars required to fire.
- **Rerank query** (`buildPassiveRerankQuery`): Tight focus on the latest assistant message only — the agent's current trajectory. Budget allocation: thinking 35%, tool-call signal 25%, assistant content 25%, user request with decay (45% when no trajectory exists, drops to 15% once combined trajectory length ≥ 200 chars). Capped at ~900 chars.

**Tool-call signal extraction:** `extractToolCallSignal()` extracts semantic arguments from tool calls (`query`, `path`, `blockId`, etc.) — the agent's *intent*, not its output. Raw tool results are intentionally excluded (noisy). File paths and URLs are scrubbed to topic words via `anchorToTopicWords()` (e.g., `server/src/services/passive-memory-recall.ts` → `passive memory recall`).

**Operational noise scrubbing:** `scrubOperationalNoise()` strips code blocks, tool call XML, tool/command names, file paths, API endpoints, and `path=`/`file=` key-value pairs from all query text. Cross-encoders are sensitive to distributional shift — operational anchors that dominate the query surface cause the reranker to over-weight structurally similar but topically irrelevant memories.

**Search pipeline with candidate accumulation:**

1. Embed the search query. Run hybrid vector + FTS5 search with cross-project score dampening.
2. Span filter: removes same-chat memories whose source messages are ≥ 80% visible in context.
3. Exclude: frozen IDs, delta IDs, already-injected IDs, already-queued IDs, superseded memories.
4. MMR diversity selection (λ = 0.55, more diversity-biased than main retrieval's λ = 0.7).
5. **Accumulate** candidates in a shared map. Unlike main retrieval (one-shot), passive recall can search multiple times per turn — each round improves candidate scores if it finds something better.
6. Cross-encoder rerank fires only after `MIN_CANDIDATES_BEFORE_RERANK` (3) candidates accumulate. Uses the `passive-memory` specific reranker instruction.
7. **Precision-over-recall:** If the reranker model is unavailable, passive recall bails entirely (no fallback to vector scores). The `MIN_RERANK_SCORE` threshold is 0.12 — higher than main retrieval's 0.05 floor.
8. Final selection capped at `memoriesPerInjection` from the budget, respecting remaining `memoriesPerTurn` headroom (default 12 total).

**Gating:**
- Query hash dedup: skips search if the query content hasn't changed since the last round.
- In-flight guard: only one search runs concurrently per chat.
- Per-turn memory budget: `totalInjected` tracked across all injection rounds; stops once the budget is exhausted.
- Iteration spacing: 3 iterations minimum between injections (tool-use path only; post-turn bypasses this).

**Injection flow:**
- Mid-turn: `peekReady(iteration)` → if ready, persist assistant boundary, push hidden system row, convert to synthetic user message via `toReplayUserMessage()`, push to agent messages, call `markApplied()` to track IDs and update delta state.
- Post-turn: `onReady(content, memoryIds)` callback pushes the system row directly to `chat.messages` and persists. IDs tracked immediately.

Passive recalls preserve the same replay constraints as normal memory deltas. The persisted chat row is hidden as `role: "system"` with `_isPassiveMemoryRecall` for storage/UI filtering, but the live agent context receives the replay-equivalent synthetic `user` message. `chatMessagesToPiMessages()` reconstructs that same synthetic user message from the hidden row on follow-up turns. Do not live-inject raw mid-transcript `system` messages; provider templates normalize or reject them, and replay must remain byte-compatible with the prompt shape the model already saw.

In headless automation turns (`chat-turn-runner.ts`), the search context includes transient in-memory assistant/tool activity appended to persisted messages. The runner persists an assistant boundary before storing the hidden recall row so replay keeps the same order as the live transcript.

## Agent Tools

The agent can explicitly save, search, forget memories, and read archived context:
- `save_memory` — store a new memory
- `search_memory` — vector + FTS5 search across all memories
- `forget_memory` — delete a memory by ID
- `search_conversation` — FTS5 search across current messages AND archived context blocks (cross-chat)
- `read_archived_context` — dereference an archive block ID to retrieve full original messages (tool outputs, code, reasoning)

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
7. **Warms prompt caches** — after a successful cycle, the cache-warm queue reads llama.cpp capacity from `/props.max_instances` (falling back to configured inference `parallel`) and builds a prioritized plan: synthetic new-agent-chat baseline first, system chat second, then recent agent chats up to the remaining slots. Execution warms lower-priority recent chats first and the baseline last, so llama.cpp's `--kv-unified` longest-prefix selection can reuse that baseline for new global chats and the global portion of new project chats.
8. **Marks the cycle** — calls `setLastSynthesis(now)` only after a successful run so failed/no-output runs can retry on a later automation tick.

Synthesis owns both the daily narrative (notebook entry) and zeitgeist maintenance (the agent calls `update_memory_block` on `blk-zeitgeist-continuity` when the continuity narrative has shifted). See [zeitgeist.md](zeitgeist.md).

**Triggers:**
- Scheduler: the built-in automation `builtin:synthesis` is checked by `automation-scheduler.ts` every 5 minutes and defaults to a 24-hour interval. It is ordered with other automations, skipped while user chat/automation work is active, and respects the sleep-mode cooldown.
- Manual automation: `POST /api/automations/builtin%3Asynthesis/run` dispatches the built-in task and records an `automation_runs` row.
- Legacy/manual memory endpoints: `POST /api/memory/synthesis/run` and `POST /api/memory/synthesis/sleep` still dispatch synthesis asynchronously (202 Accepted) and return immediately. Clients poll `/api/memory/synthesis/status` (which exposes `isSynthesizing`) to observe progress. `/sleep` stamps `settings.sleepModeTriggeredAt` so periodic synthesis is suppressed for 2 hours.

**Synthesis lock:** `system-chat.ts` exports `acquireSynthesisLock` / `releaseSynthesisLock` / `getSynthesisLock` / `isSynthesisActive`. The chat route waits on `getSynthesisLock()` before processing a user message, so synthesis and user chat are strictly serialized on the main model. Enrichment and delayed-extraction checks in the scheduler also skip while synthesis is active.

**Automation lock:** scheduled and manual automation runs also use `automation-lock.ts` so built-in synthesis, wake cycles, and custom automations cannot overlap each other.

**Reflections:** `reflection` memories (importance 7–9) are created by the agent via `save_memory` calls during synthesis, not batch-generated post-hoc.
