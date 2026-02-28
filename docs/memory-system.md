# Memory System — Technical Documentation

This document covers every functional component of the qu.je Agent memory system: how memories are created, stored, recalled, scored, deduplicated, synthesized, and decayed.

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Storage Layer](#storage-layer)
4. [Embeddings](#embeddings)
5. [Memory Creation — Three Pathways](#memory-creation--three-pathways)
   - [Automatic Extraction](#1-automatic-extraction-fire-and-forget)
   - [Explicit Tool Calls](#2-explicit-tool-calls-agent-initiated)
   - [REST API](#3-rest-api-manual--external)
6. [Deduplication](#deduplication)
7. [Memory Recall — Two Pathways](#memory-recall--two-pathways)
   - [Context Augmentation](#1-context-augmentation-implicit)
   - [Search Tool](#2-search-tool-explicit)
8. [Scoring Algorithm](#scoring-algorithm)
9. [Memory Deletion](#memory-deletion)
10. [Pre-Compaction Flush](#pre-compaction-flush)
11. [Daily Synthesis](#daily-synthesis)
12. [Scheduler](#scheduler)
13. [REST API Routes](#rest-api-routes)
14. [File Map](#file-map)
15. [Data Flow Diagrams](#data-flow-diagrams)
16. [Code Review Notes](#code-review-notes)

---

## Overview

The memory system gives agent-type chats persistent, cross-session knowledge about the user. It operates on a simple loop:

1. **Extract** — after every assistant response, an LLM pass identifies memorable facts from the conversation.
2. **Store** — facts are embedded, deduplicated against existing memories, and written to disk.
3. **Recall** — before each agent chat response, the system embeds the user's recent messages, retrieves the top-scoring memories, and injects them into the system prompt.
4. **Maintain** — a daily synthesis job merges near-duplicates, decays stale memories, and generates a human-readable summary log.

Quick-type chats bypass all of this. Memory is only active when `chat.type === "agent"`.

---

## Data Model

### `Memory` (server/src/types.ts:80)

```typescript
interface Memory {
  id: string;            // UUIDv4
  text: string;          // The fact itself, e.g. "User prefers dark mode"
  category: MemoryCategory;  // "preference" | "fact" | "behavior" | "instruction"
  importance: number;    // 1-10 scale (clamped)
  embedding: number[];   // L2-normalized vector from qwen3-embedding:0.6b
  createdAt: string;     // ISO 8601 timestamp
  lastAccessed: string;  // ISO 8601 — updated on every recall
  accessCount: number;   // Incremented each time the memory is surfaced
  sourceChatId: string;  // The chat ID where this memory originated
}
```

### `MemoryStore` (server/src/types.ts:92)

```typescript
interface MemoryStore {
  memories: Memory[];          // All memories
  lastSynthesis: string | null; // ISO 8601 timestamp of last synthesis run
}
```

### `MemorySummary` (server/src/types.ts:97)

```typescript
type MemorySummary = Omit<Memory, "embedding">;
```

Used by the REST API to return memories without the (large) embedding vectors.

### Categories

| Category      | Purpose                                        | Example                                |
|---------------|------------------------------------------------|----------------------------------------|
| `preference`  | Things the user likes, wants, or prefers       | "User prefers TypeScript over JS"      |
| `fact`        | Personal details, biographical info            | "User's name is Alex"                  |
| `behavior`    | Patterns in how the user works or communicates  | "User often asks follow-up questions"  |
| `instruction` | Explicit directives from the user              | "Always explain code before writing it"|

---

## Storage Layer

**File**: `server/src/services/memory-storage.ts`

All memories persist as a single JSON file at `~/.quje-agent/memory/memories.json`. The storage layer provides five operations:

| Function | Description |
|---|---|
| `loadMemoryStore()` | Reads and parses the JSON file. Returns `{ memories: [], lastSynthesis: null }` if the file doesn't exist. |
| `saveMemoryStore(store)` | Serializes the full store and writes it atomically. |
| `addMemory(memory)` | Loads, pushes, saves. |
| `updateMemory(id, updates)` | Loads, finds by ID, shallow-merges updates, saves. Returns `false` if not found. |
| `deleteMemory(id)` | Loads, filters out by ID, saves. Returns `false` if not found. |
| `searchMemories(queryEmbedding, topK, now?)` | Scores every memory against the query, sorts descending, returns top K. |
| `saveDailyLog(date, content)` | Writes a markdown file to `~/.quje-agent/memory/daily/{date}.md`. |

Every write operation does a full load-modify-save cycle. There is no in-memory caching or locking — reads always go to disk.

---

## Embeddings

**File**: `server/src/services/embeddings.ts`

Uses Ollama's local embedding endpoint (`POST http://localhost:11434/api/embed`) with the `qwen3-embedding:0.6b` model.

| Function | Description |
|---|---|
| `embed(text)` | Embeds a single string. Returns a `number[]` vector. |
| `embedBatch(texts)` | Embeds multiple strings in one call. Returns `number[][]`. |
| `cosineSimilarity(a, b)` | Dot product of two vectors. Works because Ollama returns L2-normalized vectors, so `dot(a,b) = cos(a,b)`. |
| `isEmbeddingModelAvailable()` | Checks Ollama's `/api/tags` to verify the model is pulled. |

The embedding model is hardcoded to `qwen3-embedding:0.6b`. It's a compact model optimized for fast local inference.

---

## Memory Creation — Three Pathways

### 1. Automatic Extraction (Fire-and-Forget)

**File**: `server/src/services/memory-extraction.ts`
**Trigger**: After every completed assistant response in an agent chat (chat.ts:206-208)

```
User sends message → LLM responds → response saved → extractMemories() fires asynchronously
```

The extraction pipeline:

1. **Build prompt**: Concatenates the user message and assistant response.
2. **LLM call**: Sends the prompt to the same chat model with `EXTRACTION_SYSTEM_PROMPT`, which instructs it to output a JSON array of `{ text, category, importance }` objects.
3. **Parse**: `parseExtractionResponse()` strips markdown fences, finds the JSON array, validates each fact has a non-empty `text` and a valid category.
4. **Deduplicate and store**: For each extracted fact, embeds it and checks against all existing memories (see [Deduplication](#deduplication)).

This is fully fire-and-forget — errors are caught and logged but never surface to the user. The extraction call uses the same `streamChat()` function as normal chat, but discards the streaming events and only collects the final text.

### 2. Explicit Tool Calls (Agent-Initiated)

**File**: `server/src/services/memory-tools.ts`

The agent LLM can directly invoke three memory tools during its tool loop:

#### `save_memory`

Parameters: `{ text: string, category: MemoryCategory, importance: number }`

Creates a new memory immediately. Embeds the text, constructs a full `Memory` object, and calls `addMemory()`. Does NOT deduplicate — this is a direct save. The agent is trusted to use this when the user explicitly asks to remember something.

#### `search_memory`

Parameters: `{ query: string }`

Embeds the query and calls `searchMemories(embedding, 5)`. Returns formatted results including the memory ID, text, category, importance, and relevance score. This allows the agent to look up specific memories on demand.

#### `forget_memory`

Parameters: `{ id?: string, query?: string }`

Two modes:
- **By ID**: Directly deletes the memory with that ID.
- **By query**: Embeds the query, searches for the closest match. Deletes it only if the match score exceeds 0.5 (a safety threshold to avoid deleting unrelated memories).

### 3. REST API (Manual / External)

**File**: `server/src/routes/memory.ts`

The full CRUD API (see [REST API Routes](#rest-api-routes)) allows creating, reading, updating, and deleting memories from any HTTP client. Memory creation via the API auto-embeds the text.

---

## Deduplication

**File**: `server/src/services/memory-extraction.ts` (lines 59, 103-141)

**Threshold**: cosine similarity > 0.85

When a new fact is extracted (via automatic extraction or pre-compaction flush), it's compared against every existing memory:

1. Embed the new fact.
2. Compute cosine similarity against each existing memory's embedding.
3. If the best match exceeds 0.85:
   - **Update** the existing memory's text to the new version (assumes the newer phrasing is more current).
   - **Update** the embedding to match the new text.
   - **Keep the higher importance** of the two (`Math.max`).
   - **Refresh** `lastAccessed` to now.
4. If no match exceeds 0.85:
   - **Create** a new memory.

Newly created memories within the same extraction batch are also added to the comparison pool (`existingMemories.push(memory)` at line 139), so two similar facts from the same conversation won't both be saved as separate memories.

Note: The `save_memory` tool (explicit agent calls) does NOT run deduplication. Only the automatic extraction and pre-compaction flush pathways do.

---

## Memory Recall — Two Pathways

### 1. Context Augmentation (Implicit)

**File**: `server/src/services/memory-context.ts`

Called at the start of every agent chat request (chat.ts:305-309). This is the primary recall mechanism:

1. **Build query**: Takes the last 3 user messages, concatenates them into a single string.
2. **Embed**: Generates a query embedding from that concatenated text.
3. **Search**: Calls `searchMemories(queryEmbedding, 5)` — retrieves top 5 scored memories.
4. **Filter**: Drops results with score ≤ 0.01 (effectively noise).
5. **Inject**: Appends a `## What you remember about this user` section to the system prompt containing the relevant memories.
6. **Update access metadata**: Fire-and-forget updates to `lastAccessed` and `accessCount` for each recalled memory.

The injected prompt section includes natural-language instructions: *"Use these memories naturally in conversation — don't list them unless asked. If memories seem outdated or contradictory, trust the user's latest statements."*

If anything fails (embedding model down, no memories exist, etc.), the function silently returns the base system prompt unchanged.

### 2. Search Tool (Explicit)

**File**: `server/src/services/memory-tools.ts`

The `search_memory` tool lets the agent actively query memories during a conversation. Unlike context augmentation (which happens once at the start), this can be called mid-conversation when the agent realizes it needs specific information. Returns top 5 results with IDs exposed for potential follow-up deletion.

---

## Scoring Algorithm

**File**: `server/src/services/memory-storage.ts` (lines 67-86)

Each memory's relevance score is a product of three factors:

```
score = cosine_similarity × recency_decay × importance_weight
```

| Factor | Formula | Range | Purpose |
|---|---|---|---|
| `cosine_similarity` | `dot(query_embedding, memory_embedding)` | [-1, 1] (typically 0-1) | Semantic relevance to the current query |
| `recency_decay` | `0.5 ^ (age_ms / HALF_LIFE_MS)` | (0, 1] | Exponential decay with 30-day half-life |
| `importance_weight` | `importance / 10` | [0.1, 1.0] | Normalized importance (1-10 → 0.1-1.0) |

**Half-life**: 30 days. A memory accessed 30 days ago has its recency factor halved. At 60 days it's at 0.25, at 90 days 0.125, etc. Accessing a memory resets its `lastAccessed`, effectively refreshing the decay clock.

**Effect**: High-importance, recently-accessed, semantically-relevant memories dominate. Old but important memories can still surface if they're a strong semantic match. Low-importance old memories effectively disappear over time.

---

## Memory Deletion

Three pathways:

1. **`forget_memory` tool**: Agent-initiated, by ID or semantic query (score > 0.5 threshold).
2. **REST API `DELETE /api/memory/:id`**: Direct deletion by ID.
3. **Synthesis merge**: Near-duplicate memories (cosine > 0.90) are consolidated — the lower-scoring duplicate is removed.

There is no automatic garbage collection based on age or score. Low-importance old memories simply score too low to ever be recalled, but they remain in storage.

---

## Pre-Compaction Flush

**File**: `server/src/services/memory-extraction.ts` (lines 144-231)
**Trigger**: After an assistant response, if `totalTokens / effectiveContextWindow > 0.75` (chat.ts:211-224)

When a conversation approaches 75% of its context window, the system does a one-time sweep of the **entire conversation history** to extract all memorable facts before older messages get pushed out by new ones.

Pipeline:

1. Concatenates all messages (`role: content`) into a single text block.
2. Sends it to the LLM with `PRE_COMPACTION_SYSTEM_PROMPT` — a more aggressive extraction prompt that emphasizes thoroughness ("this is the last chance to capture information before it's lost").
3. Extracts and deduplicates using the same logic as normal extraction (0.85 threshold).

This is also fire-and-forget. It runs alongside normal extraction (both fire concurrently after the same response).

---

## Daily Synthesis

**File**: `server/src/services/synthesis.ts`

A maintenance job that runs once per 24-hour period. Three steps:

### Step 1: Consolidate Near-Duplicates

**Threshold**: cosine similarity > 0.90 (stricter than the 0.85 extraction dedup)

Compares every memory pair. When two memories are near-identical:
- The more important one survives (keeps its text and embedding).
- `importance` is set to `max(a, b)`.
- `accessCount` values are summed.
- The duplicate is removed.

Uses an O(n²) pairwise comparison. The `merged` set ensures a memory is only merged once per synthesis run.

### Step 2: Importance Decay

For memories not accessed in over 30 days: `importance = max(1, importance - 1)`.

This is separate from the recency decay in scoring. Scoring decay is continuous and reversible (accessing a memory resets the clock). Importance decay is discrete and permanent — once importance drops, it only goes back up if the memory is updated with a higher-importance version via dedup.

### Step 3: Generate Daily Summary

Sends all current memories to the LLM and asks for a 2-4 paragraph thematic summary. The output is saved as a markdown file at `~/.quje-agent/memory/daily/{YYYY-MM-DD}.md`.

The summary includes a header with memory count and merge count. These daily logs are for human review — they're never read back by the system.

Finally, `lastSynthesis` is set to the current timestamp and the store is saved.

---

## Scheduler

**File**: `server/src/services/scheduler.ts`

Simple timer-based scheduler:

- `startScheduler()` is called once on server startup (from `server/src/index.ts`).
- Immediately checks if synthesis is due (`shouldRunSynthesis()`).
- Then sets a 1-hour `setInterval` to check again.

`shouldRunSynthesis()` returns `true` if:
- There are memories AND `lastSynthesis` is null (never run), OR
- There are memories AND 24+ hours have elapsed since `lastSynthesis`.

The synthesis can also be triggered manually via `POST /api/memory/synthesis/run`.

---

## REST API Routes

**File**: `server/src/routes/memory.ts`
**Base path**: `/api/memory`

| Method | Path | Description |
|---|---|---|
| `GET` | `/status` | Returns `{ embeddingModelAvailable, memoryCount, lastSynthesis }` |
| `GET` | `/synthesis/status` | Returns `{ lastSynthesis, memoryCount }` |
| `POST` | `/synthesis/run` | Manually triggers daily synthesis |
| `POST` | `/search` | Semantic search. Body: `{ query, topK? }`. Returns scored results without embeddings. |
| `GET` | `/` | Lists all memories (without embeddings) |
| `POST` | `/` | Create a memory. Body: `{ text, category?, importance?, sourceChatId? }`. Auto-embeds. |
| `GET` | `/:id` | Get a single memory by ID |
| `PATCH` | `/:id` | Update a memory. Re-embeds if text changes. |
| `DELETE` | `/:id` | Delete a memory by ID |

Route ordering matters: `/status`, `/synthesis/*`, and `/search` are defined **before** `/:id` to prevent Express from matching those path segments as memory IDs.

---

## File Map

```
server/src/
├── types.ts                        # Memory, MemoryStore, MemoryCategory, MemorySummary
├── routes/
│   ├── chat.ts                     # Memory integration: augmentation (L305-309), extraction (L206-208), pre-compaction (L211-224)
│   └── memory.ts                   # REST API for memory CRUD + synthesis
└── services/
    ├── memory-storage.ts           # Persistence layer (JSON file read/write, search)
    ├── memory-extraction.ts        # Automatic fact extraction + pre-compaction flush
    ├── memory-context.ts           # System prompt augmentation with recalled memories
    ├── memory-tools.ts             # save_memory, search_memory, forget_memory tool implementations
    ├── embeddings.ts               # Ollama embedding interface + cosine similarity
    ├── synthesis.ts                # Daily dedup, decay, and summary generation
    ├── scheduler.ts                # Hourly synthesis check
    ├── agent-tools.ts              # Tool registry (imports and dispatches memory tools)
    └── agent.ts                    # streamChat() — shared LLM interface used by extraction/synthesis

~/.quje-agent/memory/
├── memories.json                   # The memory store (all memories + lastSynthesis timestamp)
└── daily/
    └── {YYYY-MM-DD}.md            # Daily synthesis summaries
```

---

## Data Flow Diagrams

### Memory Creation (Automatic Extraction)

```
User message
    │
    ▼
LLM generates response (streamChat)
    │
    ▼
Response saved to chat ─────────────────────────────┐
    │                                                │
    ▼                                                ▼
SSE "done" event sent to client          extractMemories() [fire-and-forget]
                                                     │
                                                     ▼
                                         LLM extracts JSON facts
                                                     │
                                                     ▼
                                         For each fact:
                                           ├── embed(fact.text)
                                           ├── Compare vs all existing memories
                                           │     cosine > 0.85?
                                           │       ├── YES → updateMemory()
                                           │       └── NO  → addMemory()
                                           └── Push to comparison pool
```

### Memory Recall (Context Augmentation)

```
User sends message to agent chat
    │
    ▼
buildMemoryAugmentedPrompt()
    │
    ├── Concat last 3 user messages
    ├── embed(query)
    ├── searchMemories(embedding, top 5)
    │     └── score = cosine × recency × importance
    ├── Filter score > 0.01
    ├── Inject into system prompt
    └── Update lastAccessed + accessCount [fire-and-forget]
    │
    ▼
LLM sees memories in system prompt, responds naturally
```

### Daily Synthesis

```
Scheduler (hourly check)
    │
    ├── lastSynthesis null OR 24h elapsed?
    │     └── NO → skip
    │     └── YES ▼
    │
    ▼
Step 1: Pairwise dedup (cosine > 0.90)
    │  └── Merge: keep higher importance, sum access counts, remove duplicate
    ▼
Step 2: Importance decay (>30 days unused → importance -= 1)
    │
    ▼
Step 3: LLM generates thematic summary → daily/{date}.md
    │
    ▼
Update lastSynthesis, save store
```

---

## Code Review Notes

### Strengths

- **Clean separation of concerns**: Storage, extraction, context, tools, synthesis, and scheduling are each in their own file with focused responsibilities.
- **Graceful degradation**: Memory failures never break chat. Every memory pathway is wrapped in try/catch or fire-and-forget, so the system works fine even if the embedding model is down.
- **Dual dedup strategy**: 0.85 threshold at extraction time prevents new duplicates; 0.90 threshold at synthesis time catches drift duplicates that accumulated over time.
- **Recency + importance + relevance scoring**: The three-factor scoring formula is well-designed. The 30-day half-life is a reasonable default that keeps recent context fresh without completely forgetting older knowledge.
- **Access tracking**: `lastAccessed` and `accessCount` updates on recall create a positive feedback loop — useful memories stay fresh, unused ones fade.
- **Pre-compaction flush**: Smart safeguard against information loss in long conversations.
- **Batch dedup within extraction**: Adding newly created memories to the comparison pool within a single extraction pass prevents the same conversation from generating duplicate memories.

### Potential Concerns

1. **No write locking**: Every write does `load → modify → save`. If two concurrent extractions complete at similar times (e.g., normal extraction + pre-compaction flush firing from the same response), one can overwrite the other's changes. This is a known trade-off for simplicity, and the impact is low (worst case: a memory is lost and re-extracted later), but it's worth noting for high-frequency usage.

2. **O(n²) synthesis dedup**: The pairwise comparison in `runDailySynthesis()` scales quadratically with memory count. Fine for hundreds of memories, but could become slow at thousands. A spatial index (e.g., approximate nearest neighbors) would fix this if scale becomes an issue.

3. **O(n) search with no index**: `searchMemories()` iterates all memories and computes similarity against each. Same scaling concern as above, same mitigation path.

4. **`save_memory` tool skips dedup**: When the agent explicitly saves a memory, it doesn't check for duplicates. This could lead to duplicates if the agent saves something that was already captured by automatic extraction. The synthesis job will eventually merge them (at the 0.90 threshold), but there's a window where duplicates coexist.

5. **Importance decay is one-way**: Once `importance` is decremented during synthesis, only a dedup merge with a higher-importance version can restore it. There's no mechanism for the system to re-evaluate and increase the importance of a memory that becomes relevant again (though accessing it does reset the recency decay, which partially compensates).

6. **Daily log is write-only**: The synthesis summaries in `~/.quje-agent/memory/daily/` are never read by the system. They're purely for human auditing. If disk space becomes a concern, there's no rotation or cleanup.

7. **Single embedding model**: The embedding model (`qwen3-embedding:0.6b`) is hardcoded. If you change it, existing embeddings become incompatible with new ones (different vector spaces), which would silently break similarity calculations. A migration path (re-embed all memories) would be needed.

8. **Context augmentation query construction**: The system concatenates the last 3 user messages as the recall query. In conversations where the user switches topics, old messages could pull in irrelevant memories. A single-message or topic-aware query strategy might be more precise, though the current approach has the advantage of maintaining continuity across multi-turn discussions.
