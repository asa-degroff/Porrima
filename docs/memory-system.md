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
- **Delayed extraction**: time-based trigger (configurable threshold, default 30 min) runs on inactive chats. Extracts the full conversation context, injects previously-extracted memories for density, and focuses on new patterns/decisions. Tracks `lastDelayedExtractionAt` and `lastDelayedExtractionMessageIndex` per chat. Uses `updateChatExtractionState()` to avoid touching `lastModified` (preserves chat ordering).
- **Pre-compaction flush**: when conversation context is compacted, memories are extracted from the removed messages before archival. Compaction summary messages (`_isCompactionSummary`), out-of-context rows, system rows, and synthesis rows (`_isSynthesisMessage`) are filtered out to prevent extracting operational metadata or the synthesis cycle's own review of already-extracted memory content.

## Retrieval Pipeline

Memory retrieval uses a multi-stage pipeline for high-relevance results:

1. **Hybrid search** (`memory-storage.ts`): Vector search (qwen3-embedding:0.6b, 45 candidates) + FTS5 full-text search, fused via RRF (Reciprocal Rank Fusion, K=60). Post-scoring applies recency decay (30-day half-life), importance weight, and supersession penalty.

2. **Cross-encoder reranking** (`reranker.ts`): Top 30 candidates are reranked by Qwen3-Reranker-0.6B (dedicated CPU instance on port 8082) using chat-type-specific instructions:
   - **Agent**: "judge whether this memory is relevant to the user's current task, question, or topic of discussion"
   - **Quick**: "judge whether this memory contains information useful for responding"
   - Graceful fallback to RRF-only scoring if reranker is unavailable

3. **MMR diversity selection** (`memory-storage.ts`): Lambda=0.7 (70% relevance, 30% diversity) to avoid redundant memories

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

Long-running agent turns can retrieve memories without waiting for the next user message. `PassiveMemoryRecallController` runs from the HTTP chat loop and headless automation runner after tool-use iterations:

- It builds a topical query from recent visible user/assistant context, preserving agent thinking as the primary directional signal while scrubbing tool names, paths, filenames, endpoints, and command metadata so operational anchors do not dominate retrieval.
- It runs fast vector + FTS5 hybrid search first, accumulates diverse candidates with MMR, then sends only a small candidate/query set to the slower reranker.
- It caps injection frequency and total memories per turn, excludes memories already frozen/delta-injected/injected passively, and marks applied memory IDs through the memory context state.
- Ready recalls are injected before a later provider call, so the agent can use newly relevant memory while continuing the same autonomous turn.
- In headless automation turns, the search context includes the current in-memory assistant/tool activity, and the runner persists an assistant boundary before storing the hidden recall row so replay keeps the same order as the live transcript.

Passive recalls preserve the same replay constraints as normal memory deltas. The persisted chat row is hidden as `role: "system"` with `_isPassiveMemoryRecall` for storage/UI filtering, but the live agent context receives the replay-equivalent synthetic `user` message. `chatMessagesToPiMessages()` reconstructs that same synthetic user message from the hidden row on follow-up turns. Do not live-inject raw mid-transcript `system` messages; provider templates normalize or reject them, and replay must remain byte-compatible with the prompt shape the model already saw.

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
4. **Composes the system prompt** from the stable prefix only: `chat.systemPrompt` → `buildStablePrefix(...)` (persona + user doc + memory blocks + zeitgeist). Phase instructions live in user-role trigger/follow-up messages, so editing automation prompts does not invalidate the system chat's longest-common-prefix KV cache.
5. **Runs the shared headless tool loop** via `runHeadlessChatTurn()` / `runAgentLoop()` with the full system tool suite except `ask_user`. Later synthesis phases are injected through `getFollowUp` after turn boundaries.
6. **Persists output** — writes the assistant response to the system chat (with `_isSystemMessage`, `_isSynthesisMessage`, and automation metadata when present). Notebook persistence is the agent's responsibility through the `create_notebook_entry` tool; the server warns if synthesis text is produced without a notebook tool call.
7. **Marks the cycle** — calls `setLastSynthesis(now)` only after a successful run so failed/no-output runs can retry on a later automation tick.

Synthesis owns both the daily narrative (notebook entry) and zeitgeist maintenance (the agent calls `update_memory_block` on `blk-zeitgeist-continuity` when the continuity narrative has shifted). See [zeitgeist.md](zeitgeist.md).

**Triggers:**
- Scheduler: the built-in automation `builtin:synthesis` is checked by `automation-scheduler.ts` every 5 minutes and defaults to a 24-hour interval. It is ordered with other automations, skipped while user chat/automation work is active, and respects the sleep-mode cooldown.
- Manual automation: `POST /api/automations/builtin%3Asynthesis/run` dispatches the built-in task and records an `automation_runs` row.
- Legacy/manual memory endpoints: `POST /api/memory/synthesis/run` and `POST /api/memory/synthesis/sleep` still dispatch synthesis asynchronously (202 Accepted) and return immediately. Clients poll `/api/memory/synthesis/status` (which exposes `isSynthesizing`) to observe progress. `/sleep` stamps `settings.sleepModeTriggeredAt` so periodic synthesis is suppressed for 2 hours.

**Synthesis lock:** `system-chat.ts` exports `acquireSynthesisLock` / `releaseSynthesisLock` / `getSynthesisLock` / `isSynthesisActive`. The chat route waits on `getSynthesisLock()` before processing a user message, so synthesis and user chat are strictly serialized on the main model. Enrichment and delayed-extraction checks in the scheduler also skip while synthesis is active.

**Automation lock:** scheduled and manual automation runs also use `automation-lock.ts` so built-in synthesis, wake cycles, and custom automations cannot overlap each other.

**Reflections:** `reflection` memories (importance 7–9) are created by the agent via `save_memory` calls during synthesis, not batch-generated post-hoc.
