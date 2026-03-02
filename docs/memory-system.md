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

Memories persist in a SQLite database at `~/.quje-agent/memory/memories.db`, using `better-sqlite3` for synchronous bindings and the `sqlite-vec` extension for vector similarity search.

### Database Schema

Three tables:

```sql
-- Memory metadata (supports normal UPDATE)
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  importance INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  source_chat_id TEXT NOT NULL DEFAULT ''
);

-- Vector index for KNN search (vec0 virtual table)
CREATE VIRTUAL TABLE vec_memories USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[1024] distance_metric=cosine
);

-- Key-value store for system metadata
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

The two-table design separates metadata (normal SQL operations) from embeddings (vec0 virtual table for SIMD-accelerated KNN search). The `metadata` table stores the `lastSynthesis` timestamp.

### Operations

| Function | Description |
|---|---|
| `loadMemoryStore()` | JOINs `memories` + `vec_memories`, returns full `MemoryStore` shape. Used by synthesis. |
| `saveMemoryStore(store)` | DELETE all + INSERT all in a transaction. Used by synthesis after bulk mutations. |
| `addMemory(memory)` | INSERT into both tables in a transaction. |
| `updateMemory(id, updates)` | Dynamic UPDATE on `memories`; if embedding changed, DELETE + re-INSERT on `vec_memories`. |
| `deleteMemory(id)` | DELETE from both tables in a transaction. |
| `searchMemories(queryEmbedding, topK, now?)` | KNN MATCH on `vec_memories`, JOIN metadata, re-rank with recency+importance in JS. |
| `getMemoryById(id)` | Single-row lookup from `memories`. |
| `getMemoryCount()` | `SELECT COUNT(*)` — avoids loading all data. |
| `getLastSynthesis()` | Metadata key lookup. |
| `setLastSynthesis(value)` | Metadata key upsert. |
| `getAllMemories()` | All memories without embeddings — used by the list API. |
| `findDuplicates(embedding, threshold)` | KNN nearest neighbor + threshold filter — used by dedup. |
| `saveDailyLog(date, content)` | Writes a markdown file to `~/.quje-agent/memory/daily/{date}.md`. |
| `withWriteLock(fn)` | No-op passthrough (SQLite handles concurrency via WAL mode). Preserved for API compatibility. |

### Database Initialization

The database is initialized lazily via a `getDb()` singleton on first access:

1. Ensures `~/.quje-agent/memory/` directory exists
2. Opens (or creates) `memories.db`
3. Loads the `sqlite-vec` extension
4. Enables WAL journal mode
5. Creates tables (idempotent `CREATE TABLE IF NOT EXISTS`)
6. If `memories.json` exists but `memories.db` does not, auto-migrates (see [Migration](#migration-from-json))

### Migration from JSON

On first boot after the SQLite migration, `getDb()` detects `memories.json` without a corresponding `memories.db` and auto-migrates:

1. Reads the JSON file synchronously
2. Inserts all memories into both `memories` and `vec_memories` tables in a single transaction
3. Copies the `lastSynthesis` timestamp to the `metadata` table
4. Verifies the row count matches
5. Renames `memories.json` to `memories.json.bak`
6. Logs a migration summary to console

Rollback: delete `memories.db`, rename `.bak` back, deploy pre-migration code.

### Concurrency

SQLite with WAL mode handles concurrent reads and serialized writes natively. The old Promise-based `withWriteLock()` mutex is preserved as a no-op passthrough for API compatibility with callers that still wrap operations in it.

### Dedup via sqlite-vec

The `dedupAndSave()` function (in `memory-extraction.ts`) performs per-fact deduplication using `findDuplicates()`, which runs a KNN MATCH query on `vec_memories` for the single nearest neighbor, then checks if similarity exceeds the threshold:

```typescript
export async function dedupAndSave(
  facts: ExtractedFact[],
  embeddings: number[][],
  chatId: string
): Promise<void> {
  for (let i = 0; i < facts.length; i++) {
    const match = await findDuplicates(factEmbedding, 0.85);
    if (match) {
      await updateMemory(match.memory.id, { text, embedding, ... });
    } else {
      await addMemory({ ... });
    }
  }
}
```

Each fact is an independent SQLite transaction — no need to load/save the entire store. This is used by both automatic extraction and the `save_memory` tool.

---

## Embeddings

**File**: `server/src/services/embeddings.ts`

Uses Ollama's local embedding endpoint (`POST http://localhost:11434/api/embed`) with the `qwen3-embedding:0.6b` model.

| Function | Description |
|---|---|
| `embed(text)` | Embeds a single string. Returns a `number[]` vector. |
| `embedBatch(texts)` | Embeds multiple strings in one call. Returns `number[][]`. |
| `cosineSimilarity(a, b)` | Dot product of two vectors. Works because Ollama returns L2-normalized vectors, so `dot(a,b) = cos(a,b)`. Used by synthesis for pairwise comparisons; search and dedup use sqlite-vec instead. |
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
2. **LLM call with retry**: Sends the prompt to the same chat model with `EXTRACTION_SYSTEM_PROMPT`. The call is wrapped in `withRetry()` with exponential backoff (1s, 2s, 4s max retries).
3. **Parse**: `parseExtractionResponse()` strips markdown fences, finds the JSON array, validates each fact has a non-empty `text` and a valid category.
4. **Batch embedding**: All extracted facts are embedded in a single `embedBatch()` call (not sequential calls).
5. **Atomic dedup+save**: Calls `dedupAndSave()` which performs deduplication and persistence in a single locked transaction.

**Error Handling**: 
- LLM/embedding failures retry up to 2 times with exponential backoff
- Persistent failures logged to `~/.quje-agent/logs/memory-errors.log`
- Extraction metrics tracked in-memory (exposed via `GET /api/memory/status`)

This is fully fire-and-forget — errors never surface to the user. The extraction call uses the same `streamChat()` function as normal chat, but discards the streaming events and only collects the final text.

### 2. Explicit Tool Calls (Agent-Initiated)

**File**: `server/src/services/memory-tools.ts`

The agent LLM can directly invoke three memory tools during its tool loop:

#### `save_memory`

Parameters: `{ text: string, category: MemoryCategory, importance: number }`

Creates a new memory with deduplication. Embeds the text, then calls `dedupAndSave()` which:
1. Checks for existing memories with cosine similarity > 0.85
2. If a match exists: updates the existing memory with the new text/embedding and takes the max importance
3. If no match: creates a new memory

This ensures explicit saves go through the same dedup logic as automatic extraction, preventing duplicates when the agent saves something already captured.

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

**File**: `server/src/services/memory-extraction.ts` (function `dedupAndSave()`)

**Threshold**: cosine similarity > 0.85

When a new fact is created (via automatic extraction, pre-compaction flush, or explicit `save_memory` tool), it's processed by `dedupAndSave()` which performs per-fact deduplication via sqlite-vec:

1. Embed the new fact (batch embedding for multiple facts).
2. For each fact, call `findDuplicates(embedding, 0.85)` — a KNN MATCH query on `vec_memories` for the single nearest neighbor.
3. If the best match exceeds 0.85:
   - **Update** the existing memory's text to the new version (assumes the newer phrasing is more current).
   - **Update** the embedding to match the new text (DELETE + re-INSERT on `vec_memories`).
   - **Keep the higher importance** of the two (`Math.max`).
   - **Refresh** `lastAccessed` to now.
4. If no match exceeds 0.85:
   - **Create** a new memory (INSERT into both tables).

Each fact is an independent SQLite transaction — no need to load/save the entire memory store.

**Batch dedup**: Because each fact is inserted before the next is checked, newly created memories within the same extraction batch are visible to subsequent `findDuplicates()` queries. Two similar facts from the same conversation won't both be saved as separate memories.

**Pathways using dedup**:
- Automatic extraction (after each response)
- Pre-compaction flush (at 75% context window)
- Explicit `save_memory` tool calls

All three pathways use the same `dedupAndSave()` function for consistency.

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
7. **Cache**: The augmented prompt is cached per-chat via `setCachedAugmentedPrompt()` for instant retrieval by the prompt viewer UI.

The injected prompt section includes natural-language instructions: *"Use these memories naturally in conversation — don't list them unless asked. If memories seem outdated or contradictory, trust the user's latest statements."*

If anything fails (embedding model down, no memories exist, etc.), the function silently returns the base system prompt unchanged.

**Potential enhancement**: Consider using only the most recent user message (not last 3) for queries during topic switches to avoid pulling irrelevant memories.

### 2. Search Tool (Explicit)

**File**: `server/src/services/memory-tools.ts`

The `search_memory` tool lets the agent actively query memories during a conversation. Unlike context augmentation (which happens once at the start), this can be called mid-conversation when the agent realizes it needs specific information. Returns top 5 results with IDs exposed for potential follow-up deletion.

---

## Scoring Algorithm

**File**: `server/src/services/memory-storage.ts` (`searchMemories()`)

Search uses a two-phase approach:

1. **Phase 1 — sqlite-vec KNN**: Query `vec_memories` with `MATCH` for the top N nearest neighbors by cosine distance (oversampled at 3x `topK`, minimum 20). This runs in C with SIMD acceleration.
2. **Phase 2 — JS re-ranking**: For each candidate, compute the full composite score and re-sort. Recency and importance can reorder pure cosine results, so oversampling ensures good candidates aren't missed.

Each memory's relevance score is a product of three factors:

```
score = cosine_similarity × recency_decay × importance_weight
```

Where `cosine_similarity = 1 - distance` (sqlite-vec returns cosine distance).

| Factor | Formula | Range | Purpose |
|---|---|---|---|
| `cosine_similarity` | `1 - vec_distance` | [-1, 1] (typically 0-1) | Semantic relevance to the current query |
| `recency_decay` | `0.5 ^ (age_ms / HALF_LIFE_MS)` | (0, 1] | Exponential decay with 30-day half-life |
| `importance_weight` | `importance / 10` | [0.1, 1.0] | Normalized importance (1-10 → 0.1-1.0) |

**Half-life**: 30 days. A memory accessed 30 days ago has its recency factor halved. At 60 days it's at 0.25, at 90 days 0.125, etc. Accessing a memory resets its `lastAccessed`, effectively refreshing the decay clock.

**Effect**: High-importance, recently-accessed, semantically-relevant memories dominate. Old but important memories can still surface if they're a strong semantic match. Low-importance old memories effectively disappear over time.

**Performance**: The KNN query runs in native C code via sqlite-vec, so search is fast even at thousands of memories. The JS re-ranking phase only processes the oversampled candidates (not all memories).

---

## Memory Deletion

Four pathways:

1. **`forget_memory` tool**: Agent-initiated, by ID or semantic query (score > 0.5 threshold).
2. **REST API `DELETE /api/memory/:id`**: Direct deletion by ID.
3. **Synthesis merge**: Near-duplicate memories (cosine > 0.90) are consolidated — the lower-scoring duplicate is removed.
4. **Automatic purge**: During synthesis, memories not accessed in 6+ months with importance ≤2 are permanently deleted.

The automatic purge prevents unbounded memory growth and removes genuinely stale, low-value memories that haven't been useful for an extended period.

---

## Pre-Compaction Flush

**File**: `server/src/services/memory-extraction.ts` (lines 234-297)
**Trigger**: After an assistant response, if `estimatedUsage / effectiveContextWindow > 0.75` (chat.ts:224-243)

When a conversation approaches 75% of its context window, the system does a one-time sweep of the **entire conversation history** to extract all memorable facts before older messages get pushed out by new ones.

**Token Estimation**: Uses a dual heuristic for accuracy:
```typescript
const lastUsage = assistantMsg.usage?.totalTokens ?? 0;
const cumulativeOutput = chat.messages.reduce((sum, m) => sum + (m.usage?.output ?? 0), 0);
const estimatedUsage = Math.max(lastUsage, cumulativeOutput);
```

Pipeline:

1. Concatenates all messages (`role: content`) into a single text block.
2. **LLM call with retry**: Sends to the LLM with `PRE_COMPACTION_SYSTEM_PROMPT` — wrapped in `withRetry()` with exponential backoff.
3. **Batch embedding**: All extracted facts embedded in a single `embedBatch()` call.
4. Atomic dedup+save via `dedupAndSave()` with 0.85 threshold.

This is fire-and-forget. It runs concurrently with normal extraction after the same response (both protected by the write lock).

---

## Daily Synthesis

**File**: `server/src/services/synthesis.ts`

A maintenance job that runs once per 24-hour period. The entire synthesis process uses `loadMemoryStore()` + in-memory mutations + `saveMemoryStore()` for its O(n²) pairwise comparisons, which is appropriate since it runs infrequently.

### Step 1: Consolidate Near-Duplicates

**Threshold**: cosine similarity > 0.90 (stricter than the 0.85 extraction dedup)

Compares every memory pair using O(n²) pairwise comparison. The `merged` set ensures a memory is only merged once per synthesis run. When two memories are near-identical:
- The more important one survives (keeps its text and embedding).
- `importance` is set to `max(a, b)`.
- `accessCount` values are summed.
- The duplicate is removed.

**Scaling note**: Fine for hundreds of memories, but could slow at thousands. Future optimization: approximate nearest neighbors (ANN) index.

### Step 2: Importance Decay and Memory Purge

**Importance Decay**: For memories not accessed in over 30 days: `importance = max(1, importance - 1)`.

This is separate from the recency decay in scoring. Scoring decay is continuous and reversible (accessing a memory resets the clock). Importance decay is discrete and permanent — once importance drops, it only goes back up if the memory is updated with a higher-importance version via dedup.

**Memory Purge**: Memories that meet BOTH criteria are permanently deleted:
- Not accessed in 6+ months (180 days)
- Importance ≤ 2

This automatic garbage collection prevents unbounded memory growth and removes genuinely stale, low-value memories. The purge count is logged during synthesis:

```
[synthesis] Purged X stale memories (>6 months, importance ≤2)
```

### Step 3: Generate Daily Summary

Sends all current memories to the LLM and asks for a 2-4 paragraph thematic summary. The output is saved as a markdown file at `~/.quje-agent/memory/daily/{YYYY-MM-DD}.md`.

The summary includes a header with memory count, merge count, and purge count. These daily logs are for human review — they're never read back by the system.

**Note**: Daily logs accumulate indefinitely. Future enhancement: add log rotation or compression for logs older than N days.

Finally, `lastSynthesis` is set to the current timestamp and the store is saved.

---

## Scheduler

**File**: `server/src/services/scheduler.ts`

Simple timer-based scheduler:

- `startScheduler()` is called once on server startup (from `server/src/index.ts`).
- Immediately checks if synthesis is due (`shouldRunSynthesis()`).
- Then sets a 1-hour `setInterval` to check again.

`shouldRunSynthesis()` uses `getMemoryCount()` + `getLastSynthesis()` (lightweight metadata lookups, no full table load) and returns `true` if:
- There are memories AND `lastSynthesis` is null (never run), OR
- There are memories AND 24+ hours have elapsed since `lastSynthesis`.

The synthesis can also be triggered manually via `POST /api/memory/synthesis/run`.

---

## REST API Routes

**File**: `server/src/routes/memory.ts`
**Base path**: `/api/memory`

| Method | Path | Description |
|---|---|---|
| `GET` | `/status` | Returns `{ embeddingModelAvailable, memoryCount, lastSynthesis, extraction }` |
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
│   ├── chat.ts                     # Memory integration: augmentation, extraction, pre-compaction
│   └── memory.ts                   # REST API for memory CRUD + synthesis
└── services/
    ├── memory-storage.ts           # SQLite + sqlite-vec persistence layer (search, CRUD, targeted lookups)
    ├── memory-extraction.ts        # Automatic fact extraction + pre-compaction flush
    ├── memory-context.ts           # System prompt augmentation with recalled memories
    ├── memory-tools.ts             # save_memory, search_memory, forget_memory tool implementations
    ├── embeddings.ts               # Ollama embedding interface + cosine similarity
    ├── synthesis.ts                # Daily dedup, decay, and summary generation
    ├── scheduler.ts                # Hourly synthesis check
    ├── agent-tools.ts              # Tool registry (imports and dispatches memory tools)
    └── agent.ts                    # streamChat() — shared LLM interface used by extraction/synthesis

~/.quje-agent/memory/
├── memories.db                     # SQLite database (memories table + vec_memories virtual table + metadata)
├── memories.db-wal                 # WAL journal (auto-managed by SQLite)
├── memories.db-shm                 # Shared memory file (auto-managed by SQLite)
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
                                         embedBatch(all fact texts)
                                                     │
                                                     ▼
                                         For each fact:
                                           ├── findDuplicates(embedding, 0.85)
                                           │     (KNN MATCH on vec_memories)
                                           │     cosine > 0.85?
                                           │       ├── YES → updateMemory()
                                           │       └── NO  → addMemory()
                                           └── (new memory visible to next fact's query)
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
    │     ├── Phase 1: KNN MATCH on vec_memories (oversample 3x)
    │     └── Phase 2: Re-rank with score = cosine × recency × importance
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
- **SQLite + sqlite-vec storage**: Efficient per-row CRUD operations instead of loading/serializing the entire memory store. Vector similarity search runs in C with SIMD acceleration.
- **Graceful degradation**: Memory failures never break chat. Every memory pathway is wrapped in try/catch or fire-and-forget, so the system works fine even if the embedding model is down.
- **Dual dedup strategy**: 0.85 threshold at extraction time prevents new duplicates; 0.90 threshold at synthesis time catches drift duplicates that accumulated over time.
- **Recency + importance + relevance scoring**: The three-factor scoring formula is well-designed. The 30-day half-life is a reasonable default that keeps recent context fresh without completely forgetting older knowledge.
- **Access tracking**: `lastAccessed` and `accessCount` updates on recall create a positive feedback loop — useful memories stay fresh, unused ones fade.
- **Pre-compaction flush**: Smart safeguard against information loss in long conversations.
- **Batch dedup within extraction**: Each fact is inserted before the next is checked, so newly created memories are visible to subsequent `findDuplicates()` queries within the same batch.
- **Concurrency via SQLite WAL**: WAL mode allows concurrent reads with serialized writes, replacing the previous Promise-based mutex.
- **Per-fact dedup transactions**: `dedupAndSave()` performs each fact as an independent SQLite transaction via `findDuplicates()` + `updateMemory()`/`addMemory()`.
- **Error resilience**: LLM and embedding calls retry with exponential backoff (up to 2 retries). Failures logged to `~/.quje-agent/logs/memory-errors.log`.
- **Observability**: In-memory metrics track extraction success/failure rates, facts extracted, and timestamps — exposed via `GET /api/memory/status`.
- **Memory purge**: Stale memories (6+ months unused, importance ≤2) are automatically removed during synthesis to prevent unbounded growth.
- **Auto-migration**: Seamless migration from JSON to SQLite on first boot — detects `memories.json`, imports all data, renames to `.bak`.

### Resolved Concerns (Previously Noted)

1. ~~**No write locking**~~ ✅ **FIXED** — Originally resolved with Promise-based mutex. Now superseded by SQLite WAL mode which handles concurrency natively.

2. ~~**`save_memory` tool skips dedup**~~ ✅ **FIXED** — The `save_memory` tool calls `dedupAndSave()` instead of direct `addMemory()`, ensuring explicit saves go through the same dedup logic as automatic extraction.

3. ~~**O(n) search with no index**~~ ✅ **FIXED** — Search now uses sqlite-vec KNN MATCH queries running in C with SIMD acceleration. Still brute-force O(n) complexity, but the constant factor is orders of magnitude lower than the previous JS implementation.

4. ~~**JSON file I/O bottleneck**~~ ✅ **FIXED** — Migrated from single JSON file (full load/save on every operation) to SQLite with per-row CRUD. Individual operations no longer require parsing or serializing multi-MB JSON.

### Remaining Concerns

1. **O(n²) synthesis dedup**: The pairwise comparison in `runDailySynthesis()` scales quadratically with memory count. Fine for hundreds of memories, but could become slow at thousands. This still loads the full store via `loadMemoryStore()` and does JS-level pairwise cosine comparisons. A future optimization could use sqlite-vec to find near-duplicates more efficiently.

2. **Importance decay is one-way**: Once `importance` is decremented during synthesis, only a dedup merge with a higher-importance version can restore it. There's no mechanism for the system to re-evaluate and increase the importance of a memory that becomes relevant again (though accessing it does reset the recency decay, which partially compensates).

3. **Daily log is write-only**: The synthesis summaries in `~/.quje-agent/memory/daily/` are never read by the system. They're purely for human auditing. If disk space becomes a concern, there's no rotation or cleanup.

4. **Single embedding model**: The embedding model (`qwen3-embedding:0.6b`) is hardcoded. If you change it, existing embeddings become incompatible with new ones (different vector spaces), which would silently break similarity calculations. A migration path (re-embed all memories) would be needed.

5. **Context augmentation query construction**: The system concatenates the last 3 user messages as the recall query. In conversations where the user switches topics, old messages could pull in irrelevant memories. A single-message or topic-aware query strategy might be more precise, though the current approach has the advantage of maintaining continuity across multi-turn discussions.

6. **No embedding model versioning**: The `metadata` table could store the embedding model name for future migration tooling, but this isn't implemented yet.
