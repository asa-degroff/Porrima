# Compaction System

When a conversation exceeds the model's context window, the system must remove older messages to make room for new ones. This process is called **compaction**. The challenge is preserving enough context for the agent to continue working coherently.

The compaction system uses an **indexed summary** approach — full messages are archived and searchable, while a concise index replaces them in the conversation. This is lossless: nothing is deleted, only moved out of the active context window.

## Trigger Paths

There are five compaction paths, each with different timing and constraints:

| Path | Trigger | Threshold | Blocking |
|------|---------|-----------|----------|
| **End-of-turn** | After agent response completes | >85% context or `stopReason=length` | Yes — awaits flush |
| **Mid-turn** | During tool loop (>85% context) | >85% context | Yes — awaits flush |
| **Pre-send (normal)** | Before sending to LLM | >85% trigger → 30% target | Yes — awaits flush |
| **Pre-send (resume)** | Before resuming after crash/ask_user | >85% trigger → 30% target | Yes — awaits flush |
| **`/compact` command** | User-triggered | Forced | Yes — awaits flush |

All paths now **await** `preCompactionFlush` before rebuilding the system prompt, ensuring extracted memories are available for retrieval.

## Compaction Sequence

Every compaction path follows this standardized sequence:

```
1. Archive & Index   — truncateChatHistory() / truncateBeforeSend()
   ├── Groups removed messages into logical blocks
   ├── Generates LLM-written index descriptions for each block
   ├── Stores full messages in context_archives (SQLite + FTS5)
   ├── Returns indexed summary text to inject into conversation
   └── Marks removed messages as _outOfContext, strips large content

2. Memory Flush     — await preCompactionFlush()
   ├── Sends removed messages to extraction LLM
   ├── Extracts atomic memories (facts, decisions, context)
   ├── Processes block updates for importance ≥ 7
   ├── Deduplicates against existing memories
   └── Invalidates memory cache (invalidateMemoriesCache)

3. Reset Context    — resetMemoryContext()
   └── Clears frozenIds, deltaIds, frozenMemoriesSection

4. Rebuild Prompt   — buildSplitAugmentedPrompt()
   ├── Does full retrieval (no delta state → case 1)
   ├── Finds freshly extracted memories via vector+FTS+rerank
   ├── Freezes all retrieved memories into system prompt
   └── Sets up new delta tracking state for subsequent turns
```

The order matters: **flush before rebuild** ensures the system prompt includes memories just extracted from the removed messages.

## Three Preservation Layers

Compaction preserves context through three complementary mechanisms:

### Layer 1: Atomic Memories (preCompactionFlush)

Sent to the extraction LLM with the `PRE_COMPACTION_INSTRUCTIONS` system prompt, which emphasizes:
- Task state (what's being worked on, what's done, what's pending)
- Technical context (files discussed, architecture, code changes)
- User context (preferences, instructions, corrections)
- Decisions & rationale (why approaches were chosen, tradeoffs)

Extraction also supports **memory block updates** for importance ≥ 7. The LLM can `append` to or `replace_section` in existing knowledge blocks, preserving structured context that would be hard to capture as atomic memories.

### Layer 2: Indexed Archive (archiveAndIndex)

Removed messages are grouped into logical blocks and stored in `context_archives` with:
- **Full original content** (not truncated) — available via `read_archived_context`
- **LLM-generated index descriptions** — one-line summaries of what each block contains
- **FTS5 full-text search** — searchable across all chats via `search_conversation`

The archive format: `archive:{shortChatId}:{sequenceNum}` (e.g., `archive:abc12345:003`)

The agent sees an indexed summary inserted into the conversation:
```
[Compacted context — use read_archived_context to retrieve details]
Archived blocks:
- archive:abc12345:001 — User asked about compaction architecture, assistant explained design
- archive:abc12345:002 — Tool calls: read_file, edit_file fixing P0 bugs
- archive:abc12345:003 — Discussed indexed summary vs narrative summary tradeoffs
```

### Layer 3: System Prompt (buildSplitAugmentedPrompt)

After compaction, the system prompt is rebuilt from scratch:
- All memories (including freshly extracted ones) are retrieved via vector search + FTS5 + reranking
- Retrieved memories are frozen into the system prompt for KV cache efficiency
- Delta tracking state is reset, so subsequent turns use the frozen prompt as a stable prefix

## Mid-Turn Compaction

Mid-turn compaction has additional complexity because the agent is in the middle of a tool loop. The process:

1. **Build progress summary** — captures the assistant's text output and tool calls so far
2. **Archive & flush** — standard compaction sequence (awaited)
3. **Rebuild system prompt** — includes freshly extracted memories
4. **Fetch chat memories** — `getMemoriesFromChat(chatId, 10)` after flush, so newly extracted memories are included
5. **Assemble handoff message** — combines progress summary + memories + "continue from where you left off"
6. **Resume via `agentLoopContinue`** — the handoff message is appended as a user message

The handoff message gives the resumed agent two things:
- **System prompt**: Contains freshly extracted memories (frozen) + memory blocks + project context
- **Handoff message**: Explicit list of what was done, what tools were called, and key memories

This belt-and-suspenders approach ensures continuity even if the semantic retrieval misses something.

## Memory Context State Management

The `buildSplitAugmentedPrompt` function manages a delta-based memory context for KV cache efficiency:

- **Case 1 (No state / post-reset)**: Full retrieval. All memories go into the system prompt. New state is created with `frozenIds` and `frozenMemoriesSection`.
- **Case 2 (State exists, not dirty)**: Reuse the frozen system prompt. No delta needed.
- **Case 3 (State exists, dirty)**: Re-retrieve, compute delta (only new memories not already in context). Delta is appended as a message after the conversation history.

After compaction, `resetMemoryContext()` deletes the state, forcing Case 1 on the next `buildSplitAugmentedPrompt` call. This is critical — the frozen system prompt referenced stale messages that are now archived.

## Archive Format

### Storage Schema

```sql
CREATE TABLE context_archives (
  id TEXT PRIMARY KEY,           -- archive:abc12345:001
  chatId TEXT NOT NULL,
  sequenceNum INTEGER NOT NULL,
  messages JSON NOT NULL,         -- Full original messages (untruncated)
  indexEntry TEXT NOT NULL,       -- LLM-generated description
  messageCount INTEGER NOT NULL,
  estimatedTokens INTEGER,
  createdAt TEXT NOT NULL,
  UNIQUE(chatId, sequenceNum)
);

CREATE VIRTUAL TABLE context_archives_fts USING fts5(
  content,       -- Full message JSON (searchable)
  indexEntry,    -- LLM descriptions (searchable)
  chatId UNINDEXED,
  content='context_archives'
);
```

### Block Grouping

Messages are grouped into logical blocks before archiving:

- **User + visible assistant turn** → one block, including all consecutive `_toolLoopId` assistant fragments
- **Standalone visible assistant turn** → one block for all consecutive `_toolLoopId` assistant fragments
- **Legacy collapsed assistant-with-tools row** → one block
- **Standalone message** → one block

### Index Generation

Each block gets an LLM-generated one-line description using the dedicated CPU extraction model (avoids GPU contention). If the LLM call fails, a fallback description is generated from truncated content previews.

The extraction prompt focuses on:
- **What** the block contains (commands run, files read, decisions made)
- **Why** it might be useful later (retrieval cues for the agent)

### Agent Retrieval

Two tools access archived context:

1. **`read_archived_context(archive_id)`** — Retrieves full untruncated content of a specific archive block. The agent sees the archive ID in the compaction summary and can dereference it.

2. **`search_conversation(query)`** — Searches both live messages and archive blocks via FTS5. Returns archive IDs with their index descriptions, prompting the agent to use `read_archived_context` for details.

## Key Design Decisions

### Why await instead of fire-and-forget?

Previous implementations used `.catch()` (fire-and-forget) for `preCompactionFlush`. This created a race condition: `buildSplitAugmentedPrompt` ran before the flush completed, so freshly extracted memories weren't in the store during retrieval. The system prompt would be rebuilt without the context that was just removed.

By awaiting the flush, we guarantee that the rebuilt system prompt includes all memories extracted from the removed messages.

### Why indexed summaries instead of narrative summaries?

The old approach (`generateCompactionSummary`, now removed) asked an LLM to write a paragraph summarizing removed messages. Problems:
- **Lossy**: Anything the summarizer chose not to include was lost
- ** unverifiable**: The agent couldn't check the original content
- **Single point of failure**: A bad summary meant permanent context loss

The indexed approach:
- **Lossless**: Full messages are always stored and retrievable
- **Verifiable**: The agent can `read_archived_context` to check original content
- **Multiple access paths**: Semantic search, FTS search, and direct ID reference

### Why lower importance threshold for block updates during compaction?

Normal extraction uses importance ≥ 8 for block updates. During compaction, the threshold is lowered to 7 because:
- Messages are being **removed from context** — information that would normally stay visible needs more aggressive preservation
- Moderate-importance architectural decisions (importance 7) are exactly the kind of information that blocks are designed to organize
- The pre-compaction system prompt explicitly includes existing block content, so the LLM can make informed update decisions

### Why both system prompt AND handoff message for mid-turn?

The system prompt is the authoritative source — it contains semantically retrieved memories via the full retrieval pipeline. But the handoff message provides explicit, visible continuity:
- The agent's attention is drawn to the handoff message first
- It includes task-specific context (what was being worked on, what tools were called) that may not rank highly in semantic retrieval
- It's a redundancy measure: if semantic retrieval misses a critical memory, the handoff message may still include it

### Why buildSplitAugmentedPrompt everywhere?

The legacy `buildMemoryAugmentedPrompt` returns a single string without setting up the delta tracking state (`contextState`). This means:
- Subsequent turns through `buildSplitAugmentedPrompt` find no state and do a full retrieval (redundant embedding + reranking)
- Or worse, find stale state from before compaction and compute a wrong delta

By using `buildSplitAugmentedPrompt` everywhere, we ensure:
1. The `contextState` is properly initialized with `frozenIds` and `frozenMemoriesSection`
2. Subsequent turns can do efficient delta retrieval (case 2: not dirty → reuse frozen prompt)
3. KV cache prefix matching works correctly across turns

The only remaining uses of `buildMemoryAugmentedPrompt` are in non-compaction contexts (chat listing cache) where delta tracking is not needed.

### Memory delta injection

The `buildSplitAugmentedPrompt` returns both `systemPrompt` and `memoriesMessage` (the delta). For compaction paths, the delta is always empty because `resetMemoryContext` forces a full retrieval (case 1). For normal turns, the delta contains only memories not already in the frozen system prompt, and is injected as a user message at the end of context:

```
[System context — updated memories]
- New memory text [category, importance: N/10, saved: 2026-04-11]
```

This preserves the KV cache prefix (system prompt stays byte-identical) while ensuring new memories reach the model.
