# Compaction System

When a conversation exceeds the model's context window, the system must remove older messages to make room for new ones. This process is called **compaction**. The challenge is preserving enough context for the agent to continue working coherently.

The compaction system uses an **indexed summary** approach — full messages are archived and searchable, while a concise index replaces them in the conversation. This is lossless: nothing is deleted, only moved out of the active context window.

## Trigger Paths

Compaction runs at many sites, and they differ in three axes: **trigger**, **mid-turn cycle cap**, and **whether the memory flush runs**.

| Path | Trigger | Threshold | Cycles | Flush? | Blocking? |
|------|---------|-----------|--------|--------|-----------|
| Pre-send, send | Before POST to LLM | 3 triggers (below) → 30% target | — | yes | yes |
| Pre-send, resume | Before resuming after crash / `ask_user` | same | — | yes | yes |
| Pre-send, `/edit` | Before resending an edited message | same | — | yes | yes |
| Pre-send, artifact repair | Before a hidden repair turn | same | — | yes | yes |
| Pre-send, synthesis | System-chat turn start | same | — | **no** | yes |
| Pre-send, wake | System-chat turn start | same | — | **no** | yes |
| Pre-send, automation | Automation turn start | same | — | **no** | yes |
| Mid-turn, HTTP | During tool loop | >85% normal, >95% hard cap | 5 | yes (agent chats only) | yes |
| Mid-turn, headless | During tool loop | same | **3** | **no** | yes |
| End-of-turn, HTTP | After the response completes | **>80%** or `stopReason=length` | — | yes | yes |
| End-of-turn, synthesis | After the response completes | >80% | — | **no** | yes |
| End-of-turn, wake | After the response completes | >80% | — | **no** | yes |
| End-of-turn, automation | After the response completes | >80% | — | **no** | **computed and logged only** |
| `/compact` | User-triggered | Forced | — | yes | yes |
| Hard-cap safety | Inside pre-send | see below | — | inherits | yes |

Three numbers are easy to confuse:

- **0.80** — `END_OF_TURN_COMPACTION_TRIGGER_RATIO`. End-of-turn fires *earlier* than pre-send's 0.85, because it runs while the user is reading rather than waiting.
- **0.85** — `COMPACTION_TRIGGER_RATIO`, the normal pre-send trigger, measured against the usage-anchored `refinedTokens`.
- **0.95 / 1.15** — `COMPACTION_HARD_CAP_RATIO` and `CHAR_ESTIMATE_SAFETY_RATIO`. Pre-send actually has **three** independent triggers: the normal 0.85 check, an anchor-bounded hard-cap estimate above 0.95, and a pure char estimate above **1.15** of the window. The char band is deliberately looser than the hard cap because char estimation is the less trustworthy of the two.

**The memory flush is HTTP-only.** The HTTP chat route passes `preCompactionFlush` as the `onBeforeArchive` hook. Headless paths — synthesis, wake, automation, and headless mid-turn — pass `undefined` for that argument and therefore **skip the flush entirely**. This is tracked as delta D4 in [design/turn-engine.md](design/turn-engine.md); the automation end-of-turn compaction is additionally still gated behind `logOnly: true`.

## Compaction Sequence

Compaction itself is a primitive. It collects the removed messages, runs the flush hook, archives and indexes, and splices in a summary. **The memory-context reset and prompt rebuild are caller-owned aftermath**, not part of the primitive.

```
IN truncateChatHistory() / truncateBeforeSend():

1. Collect removed messages

2. Memory Flush     — await onBeforeArchive(preCompactionFlush)   [HTTP paths only]
   ├── Sends removed messages to the extraction LLM
   ├── Extracts atomic memories (facts, decisions, context)
   ├── Processes block updates for importance >= 7
   └── Invalidates memory cache (invalidateMemoriesCache)

3. Archive & Index   — archiveAndIndex()
   ├── Groups removed messages into logical blocks
   ├── Writes index descriptions per block (see "Index Generation" below)
   ├── Stores full messages in context_archives (SQLite + FTS5)
   ├── Returns indexed summary text to inject into conversation
   └── Marks removed messages as _outOfContext, strips large content

4. Stale-anchor strip
   ├── Every KEPT role:"system" row is marked _outOfContext
   └── Every KEPT assistant row's `usage` is cleared
       (a surviving pre-compaction anchor would inflate Path A and
        trigger a spurious compaction on the next turn)

5. Splice summary into the conversation
```

The flush runs **before** archive/index generation, not after, and the ordering is deliberate: the flush continues the extraction session's cached prompt, and index generation would evict it.

Step 4 has a significant consequence that is easy to miss: immediately after any compaction the estimator has **no** usage anchor at all. `selectedPath` falls back to `char_estimate`, and only the 0.95 hard-cap ratio is live until the next provider call reports usage.

### Caller-owned aftermath

After the primitive returns, the HTTP route does:

```
6. Soft reset     — softResetMemoryContext(chatId)
   └── Clears deltaIds and marks dirty; frozenIds and the frozen
       memories section are retained BYTE-EXACT

7. Rebuild        — buildSplitAugmentedPrompt()
   └── Case 3 (dirty): re-retrieves and returns BOTH a system prompt
       and a memories delta + its new memory ids — claims nothing yet

8. Deliver        — caller puts the delta on the wire and saves, then
   calls commitMemoryDelta(ids) to record delivery

9. Reinject skills + setCachedAugmentedPrompt()
```

A **hard** `resetMemoryContext()` (which clears the frozen set entirely and forces a Case 1 freeze) is no longer used after compaction. It survives only where a re-roll is genuinely owed: chat deletion, automation start, zeitgeist rewrite, and cache-warm preparation. Re-rolling the frozen set at compaction was pure nondeterminism — a 5 → 4 → 0 → 3 frozen-set sequence was observed in one night — which broke the prefix at the section boundary and orphaned the KV pool each time.

> ### Delta delivery across paths
>
> The delivery-receipt model: Case 3 no longer writes ids into `deltaIds`. It returns the delta plus `newMemoryIds`, and `deltaIds` grows only in `commitMemoryDelta`, which callers invoke after the save that makes the delta durable. A caller that never commits leaves `dirty` set, so the next delivering build re-retrieves the same memories — the failure direction is a possible duplicate, never a silent loss (the same contract passive recall enforces with `markPersisted`).
>
> Same-turn delivery is in place at every path that has a turn to carry it:
> - send persists a hidden row and merges it into the user message (`:5176` rebuild, commit `:5253`)
> - resume merges into the ask_user toolResult and persists a hidden replay row (`:4927`, commit `:4988`)
> - mid-turn folds it into the handoff row (`:3590`, commit `:3631`)
> - `/edit` merges into the edited user message (`:5910`, commit `:5975`)
> - automation runs — in-chat reminders and wakes with `enableMemoryRetrieval: true` — persist a hidden row directly before the row the run answers (the trigger, or the delivered cross-chat post) and commit it (`automation-runner.ts:294` build, delivery `:337`, commit `:358`). `agent.ts` merges that row into the following user message, so both the live run and later replays carry it.
>
> Sites with no turn to carry it pass `stableOnly: true`: the build hydrates and returns the retained frozen section but skips the Case 3 re-retrieval, so the delta stays owed to the next delivering build at zero retrieval cost (with no live state it falls through to Case 1, where a freeze is delivered by the prompt itself) — end-of-turn rebuild (`:3986`), queued follow-up (`:4140`), and the `/compact` budget estimate (`:4579`; the "not enough messages to compact" branch `:4677` returns without a follow-up).
>
> Cache warm (`cache-warm.ts:300-314`) hard-resets first, so its build is always Case 1: the frozen section it establishes is what the warm bakes, and the next turn's delta rides on top.

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

After compaction the prompt is rebuilt, but the frozen set survives:
- `softResetMemoryContext()` keeps `frozenIds` and the frozen memories section byte-exact — no re-roll
- Memories extracted by the flush are retrieved on the next build (Case 3) and returned as an appended delta, not folded back into the system prompt (delivering callers must commit it — see the delta-delivery note above)
- Accumulated delta tracking is cleared, so subsequent turns reuse the frozen prompt as a stable prefix

## Mid-Turn Compaction

Mid-turn compaction has additional complexity because the agent is in the middle of a tool loop. The process:

1. **Build progress summary** — captures the assistant's text output and tool calls so far
2. **Archive & flush** — standard compaction sequence (awaited)
3. **Rebuild system prompt** — `softResetMemoryContext()` retains the frozen section byte-exact; the recall delta is returned alongside it (see the delta-delivery note above)
4. **Fetch chat memories** — `getMemoriesFromChat(chatId, 10)` after flush, so newly extracted memories are included
5. **Assemble handoff message** — combines progress summary + memories + "continue from where you left off"
6. **Resume via `agentLoopContinue`** — the handoff message is appended as a user message

The handoff message gives the resumed agent two things:
- **System prompt**: The retained frozen memories section + memory blocks + project context
- **Handoff message**: Explicit list of what was done, what tools were called, and key memories

This belt-and-suspenders approach ensures continuity even if the semantic retrieval misses something.

## Memory Context State Management

The `buildSplitAugmentedPrompt` function manages a delta-based memory context for KV cache efficiency:

- **Case 1 (No state / post-reset)**: Full retrieval. All memories go into the system prompt. New state is created with `frozenIds` and `frozenMemoriesSection`.
- **Case 2 (State exists, not dirty)**: Reuse the frozen system prompt. No delta needed.
- **Case 3 (State exists, dirty)**: Re-retrieve, compute delta (only new memories not already in context). Delta is appended as a message after the conversation history.

After compaction, `softResetMemoryContext()` clears `deltaIds` and marks the state dirty while keeping the frozen set byte-exact. The next `buildSplitAugmentedPrompt` call is therefore **Case 3**: it re-retrieves against the compacted history and returns new memories as a delta plus their ids. Nothing is claimed until the caller delivers the delta and commits the ids (`commitMemoryDelta`); a site without a delivery point leaves the delta owed (see the delta-delivery note above).

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

Each block gets a one-line description, produced in one of two modes:

- **`sync`** (end-of-turn, mid-turn, `/compact`): the LLM (dedicated CPU extraction model, avoiding GPU contention) writes the description and blocks the compaction. Used where the summary may be consumed immediately, because the agent loop resumes right after.
- **`deferred`** (**pre-send**, the common case): the archive is written immediately with a mechanical `generateFallbackDescription()` derived from truncated content previews, then `enrichArchiveDescriptions()` runs fire-and-forget in the background. It upgrades the archive rows *and* patches the persisted `_isCompactionSummary` message under the chat write lock (best-effort, 3 retries) so future contexts see the richer text. The point is not to make the user turn wait on a CPU model.

So on the pre-send path the summary the model actually sees in the immediately following turn is the *mechanical* one; the LLM description lands a moment later.

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

On the **HTTP paths**, awaiting the flush guarantees that the rebuilt system prompt includes memories extracted from the removed messages. The headless paths have not adopted this — the `onBeforeArchive` hook is `undefined` there, so the flush is skipped (see [design/turn-engine.md](design/turn-engine.md) delta D4).

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

The legacy single-string builder (`buildMemoryAugmentedPrompt`) returned a prompt without setting up the delta tracking state (`contextState`). Routing a turn through it meant:
- Subsequent turns through `buildSplitAugmentedPrompt` find no state and do a full retrieval (redundant embedding + reranking)
- Or worse, find stale state from before compaction and compute a wrong delta

By using `buildSplitAugmentedPrompt` everywhere, we ensure:
1. The `contextState` is properly initialized with `frozenIds` and `frozenMemoriesSection`
2. Subsequent turns can do efficient delta retrieval (case 2: not dirty → reuse frozen prompt)
3. KV cache prefix matching works correctly across turns

The legacy builder has been removed; the chat listing path reads the per-chat prompt cache (`getCachedAugmentedPrompt`) instead.

### Memory delta injection

The `buildSplitAugmentedPrompt` returns both `systemPrompt` and `memoriesMessage` (the delta), plus the delta's `newMemoryIds`. Post-compaction builds are Case 3, not Case 1: `softResetMemoryContext` keeps the frozen section byte-exact while memories extracted by the flush arrive as a delta; the delivering caller commits the ids after its save (see the delta-delivery note above for sites that defer it). For normal turns, the delta contains only memories not already in the frozen system prompt, and is injected as a user message at the end of context:

```
[System context — updated memories]
- New memory text [category, importance: N/10, saved: 2026-04-11]
```

This preserves the KV cache prefix (system prompt stays byte-identical) while ensuring new memories reach the model.
