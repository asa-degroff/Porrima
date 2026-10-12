# Compaction System

When a conversation exceeds the model's context window, the system must remove older messages to make room for new ones. This process is called **compaction**. The challenge is preserving enough context for the agent to continue working coherently.

The compaction system uses an **indexed summary** approach — full messages are archived and searchable, while a concise index replaces them in the conversation. This is lossless: nothing is deleted, only moved out of the active context window.

**End-of-turn is the primary path; pre-send is the backstop.** Compaction that runs pre-send makes the user wait for it *at the keyboard*, mid-request — the Aug 22 incident (a 7-minute pre-send wait) is what drove the rework. Since then every expected compaction fires **after the response completes, while the user is reading**. Pre-send still runs, but in steady state it should rarely fire on agent chats: it exists to catch what end-of-turn structurally cannot see (the next user message itself, and any rows added after the turn ended), plus crash/`ask_user` resumes where no end-of-turn check ran.

## Trigger Paths

Five compaction paths — end-of-turn, mid-turn, pre-send (backstop), manual `/compact`, and the hard-cap safety net — and they differ on three axes: **trigger**, **mid-turn cycle cap**, and **whether the memory flush runs**.

| Path | Trigger | Threshold | Cycles | Flush? | Blocking? |
|------|---------|-----------|--------|--------|-----------|
| End-of-turn, HTTP | After the response completes | **>80%** or `stopReason=length` | — | yes | yes |
| End-of-turn, synthesis | After the response completes | >80% | — | **no** | yes |
| End-of-turn, wake | After the response completes | >80% | — | **no** | yes |
| End-of-turn, automation | After the response completes | **>85%** (D3 verdict, see below) | — | **no** | yes |
| Mid-turn, HTTP | During tool loop | >85% with a usage anchor; char path only checks >95% | 5 | yes | yes |
| Mid-turn, headless | During tool loop | same | **3** | **no** | yes |
| Pre-send, send *(backstop)* | Before POST to LLM | 3 triggers (below) → 30% target | — | yes | yes |
| Pre-send, resume *(backstop)* | Before resuming after crash / `ask_user` | same | — | yes | yes |
| Pre-send, `/edit` *(backstop)* | Before resending an edited message | same | — | yes | yes |
| Pre-send, synthesis *(backstop)* | System-chat turn start | same | — | **no** | yes |
| Pre-send, wake *(backstop)* | System-chat turn start | same | — | **no** | yes |
| Pre-send, automation *(backstop)* | Automation turn start | same | — | **no** | yes |
| `/compact` | User-triggered | Forced | — | yes | yes |
| Hard-cap safety | Inside pre-send, after the primary truncation | see below | — | inherits | yes |

What the backstop is for, precisely: end-of-turn runs *inside the turn*, so it cannot see the next user message, rows persisted after the check (passive-recall deltas, queued follow-ups), or turns where the end-of-turn check was skipped by a route gate (`ask_user`, waiting-for-input, mid-turn cycle exhaustion, `/stop`). The pre-send comment on `COMPACTION_TRIGGER_RATIO` states the contract: *"Pre-send stays at 0.85 as the backstop for what end-of-turn can't see."* On headless paths (synthesis, wake, automation) there is no human waiting on the request, so pre-send running there is cheap. Automations execute end-of-turn at **0.85** rather than 0.80: the D3 gate week (Sep 20 – Oct 11, 25 decision lines) put 20% of sampled turns inside the (0.80, 0.85] band, and the pre-defined decision rule in [design/turn-engine.md](design/turn-engine.md) §9 reads that as "the pre-send backstop is close enough — the extra compactions buy little." Flipping to executing (10-12) kept that ratio; what changed is *placement* — a run that finishes at 94% or 104% of the window now compacts at the end of that run instead of making the next run wait in pre-send.

Three numbers are easy to confuse:

- **0.80** — `END_OF_TURN_COMPACTION_TRIGGER_RATIO`. End-of-turn fires *earlier* than pre-send's 0.85, because it runs while the user is reading rather than waiting (automations pass their own 0.85 — see the table note). The decision is the conservative `max(rawUsage, refinedEstimate)` — either signal crossing fires (never both-below-when-either-above; the Aug 22 dead band was exactly that miss).
- **0.85** — `COMPACTION_TRIGGER_RATIO`, the normal pre-send trigger, measured against `refinedTokens`: the usage-anchored display estimate when a post-compaction anchor exists, otherwise the char estimate (see *Stale-anchor strip* below).
- **0.95 / 1.15** — `COMPACTION_HARD_CAP_RATIO` and `CHAR_ESTIMATE_SAFETY_RATIO`. Pre-send actually has **three** independent triggers: the normal 0.85 check, a hard-cap estimate above 0.95 (bounded by the anchor when one exists), and a pure char estimate above **1.15** of the window. The char band is deliberately looser than the hard cap because char estimation is the less trustworthy of the two.

**The memory flush is HTTP-only.** The HTTP chat route passes `preCompactionFlush` as the `onBeforeArchive` hook. Headless paths — synthesis, wake, automation (both pre-send and end-of-turn), and headless mid-turn — pass `undefined` for that argument and therefore **skip the flush entirely**. This is tracked as delta D4 in [design/turn-engine.md](design/turn-engine.md) and is now the only compaction behavior headless still misses: the automation D3 log-only gate was removed when the flip landed (10-12), so every path executes. The skip bites hardest where the headless runner compacts **user agent chats** — in-chat reminders and cross-chat wakes run on the target chat with its own `chatType`, and those chats carry a live extraction session whose flush would continue a warm prefix; there the removed context is lost to memory permanently. On the system chat itself the substantive-row filter (Layer 1) self-scopes the flush to near-zero.

## Compaction Sequence

Compaction itself is a primitive. It collects the removed messages, runs the flush hook, archives and indexes, and splices in a summary. **The memory-context reset and prompt rebuild are caller-owned aftermath**, not part of the primitive.

```
IN truncateChatHistory() / truncateBeforeSend():

1. Collect removed messages
   ├── Deep-copies so later content-stripping never mutates the objects
   │   handed to the flush or to archiveAndIndex
   └── Re-archives contiguous previously-compacted `_outOfContext`
       predecessors so the archive keeps full fidelity for the whole
       out-of-context region (their stored content was stripped)

2. Memory Flush     — await onBeforeArchive(preCompactionFlush)   [HTTP paths only]
   ├── Continues the chat's live extraction session with the removed
   │   messages (see Layer 1)
   ├── Extracts atomic memories (with subject lines + durability)
   └── Invalidates memory caches (invalidateMemoriesCache)

3. Archive & Index   — archiveAndIndex()
   ├── Groups removed messages into logical blocks
   ├── Writes index descriptions per block (see "Index Generation" below)
   ├── Stores full messages in context_archives (SQLite + FTS5)
   └── Returns indexed summary text to inject into conversation

4. Mark & strip      — every removed message gets `_outOfContext`; tool
   results/thinking over 500 chars are truncated with an "[archived]"
   marker; image payloads are dropped (archives keep the originals)

5. Splice summary    — the `_isCompactionSummary` row is inserted before
   the first kept in-context message

6. Stale-anchor strip
   ├── Every KEPT role:"system" row is marked _outOfContext
   │   (its content moves into the rebuilt frozen prompt)
   └── Every KEPT assistant row's `usage` is cleared
       (a surviving pre-compaction anchor would inflate Path A and
        trigger a spurious compaction on the next turn)

7. Title regeneration — the title is re-generated from the kept
   in-context messages (title-generation service; failure is non-fatal)

8. KV-snapshot invalidate (both truncation entries)
   └── The message spine just changed: any parked KV snapshot no longer
       matches what the rebuilt history replays, so it is dropped
       (docs/design/kv-snapshot-parking.md §5.5). truncateChatHistory
       invalidates at the funnel; truncateBeforeSend's own archive step
       is a spine rewrite that never passes through that funnel, so it
       invalidates directly (idempotent with the hard-cap pass below)

9. Hard-cap safety pass (truncateBeforeSend only)
   └── If the actual payload still exceeds 0.95 (anchor-bounded) or the
       raw char estimate exceeds 1.15, force `truncateChatHistory`
       aggressive compaction to the 30% target
```

The flush runs **before** archive/index generation, not after, and the ordering is deliberate: the flush continues the extraction session's cached prompt, and index generation shares the same single slot and would evict it. Stop-signal checks land before the flush, between flush and archive, and before any mutation — a `/stop` must not leave a half-compacted spine.

Step 6 has a consequence that is easy to misread: immediately after a compaction the estimator has **no** usage anchor, and `estimateContextBreakdown` falls through to the char path (`selectedPath: "char_estimate"`). That does **not** mean only the hard cap is live — the char estimate *becomes* `refinedTokens`/display, so the normal 0.85 pre-send check and the 0.80 end-of-turn check both stay live on char numbers (with the char path's usual 20–35% positive bias; the 09-09 trigger looked like a usage-anchor fire until the journal showed the char path drove it). It is only the **mid-turn** decision that downgrades: `midTurnPressureDecision` maps the char path to `hardCapTokens` against 0.95 instead of `refinedTokens` against 0.85. The anchor regime resumes as soon as the next provider call reports usage.

### Caller-owned aftermath

After the primitive returns, the HTTP route does:

```
A. Soft reset     — softResetMemoryContext(chatId)
   └── Clears deltaIds and marks dirty; frozenIds and the frozen
       memories section are retained BYTE-EXACT

B. Rebuild        — buildSplitAugmentedPrompt()
   └── Case 3 (dirty): re-retrieves and returns BOTH a system prompt
       and a memories delta + its new memory ids — claims nothing yet

C. Deliver        — caller puts the delta on the wire and saves, then
   calls commitMemoryDelta(ids) to record delivery

D. Aftercare      — reinject skills + setCachedAugmentedPrompt()
```

A **hard** `resetMemoryContext()` (which clears the frozen set entirely and forces a Case 1 freeze) is no longer used after compaction. It survives only for chat deletion and cache-warm preparation; automation and system-chat runs retain the frozen set as follow-up messages in a persistent chat. Re-rolling the frozen set at compaction was pure nondeterminism — a 5 → 4 → 0 → 3 frozen-set sequence was observed in one night — which broke the prefix at the section boundary and orphaned the KV pool each time.

> ### Delta delivery across paths
>
> The delivery-receipt model: Case 3 no longer writes ids into `deltaIds`. It returns the delta plus `newMemoryIds`, and `deltaIds` grows only in `commitMemoryDelta`, which callers invoke after the save that makes the delta durable. A caller that never commits leaves `dirty` set, so the next delivering build re-retrieves the same memories — the failure direction is a possible duplicate, never a silent loss (the same contract passive recall enforces with `markPersisted`).
>
> Same-turn delivery is in place at every path that has a turn to carry it (symbolic references — line numbers rot with every chat.ts change):
> - **send** — the post-`truncateBeforeSend` rebuild persists a hidden row and merges it into the user message; commit after that save.
> - **resume** — merges into the ask_user toolResult and persists a hidden replay row; commit after the save.
> - **mid-turn** — folds the delta into the handoff row; commit after the handoff save.
> - **`/edit`** — merges into the edited user message; commit after the edit saves.
> - **artifact repair** (`POST /api/chat/artifact-error`, non-streaming branch) — builds *without* `stableOnly`, persists the delta as a hidden system row directly before the repair row (anchored by row id, not tail position, for rebase safety), and commits after that save.
> - **automation runs** — in-chat reminders and wakes with `enableMemoryRetrieval: true` — persist a hidden row directly before the row the run answers (the trigger, or the delivered cross-chat post) and commit it after the save. `agent.ts` merges that row into the following user message, so both the live run and later replays carry it.
>
> Sites with no turn to carry it pass `stableOnly: true`: the build hydrates and returns the retained frozen section but skips the Case 3 re-retrieval, so the delta stays owed to the next delivering build at zero retrieval cost (with no live state it falls through to Case 1, where a freeze is delivered by the prompt itself) — the end-of-turn `onCompacted` rebuild, the queued-follow-up rebuild, and the `/compact` budget estimate (the "not enough messages to compact" branch returns without a follow-up).
>
> Cache warm (`cache-warm.ts`) hard-resets first, so its build is always Case 1: the frozen section it establishes is what the warm bakes, and the next turn's delta rides on top.

## Three Preservation Layers

Compaction preserves context through three complementary mechanisms:

### Layer 1: Atomic Memories (preCompactionFlush)

The flush is **a continuation of the chat's live immediate-extraction session**, not a standalone prompt build: the same system prompt means the same KV prefix, so it re-uses the warm cache from earlier extraction pulses. The `[PRE-COMPACTION]` framing (`PRE_COMPACTION_USER_HEADER`) rides in the **user turn** so the cached prefix stays byte-stable, and the header emphasizes:
- Task state (what's being worked on, what's done, what's pending)
- Technical context (files discussed, architecture, code changes)
- User context (preferences, instructions, corrections)
- Decisions & rationale (why approaches were chosen, tradeoffs)

When the removed window doesn't fit the extraction input budget alongside the pruned session history, the flush runs a **chunked continuation** — each chunk appends as a new user turn on top of the prior chunk's exchange — degrading to independent calls once the dialogue outgrows the budget. Output memories carry a `subject` topic line and a `durability` ("durable" / "session") field alongside category and importance.

Removed rows are first filtered to substantive content (`isSubstantiveForPreCompactionExtraction`): compaction summaries, mid-turn/synthesis rows, automation trigger boilerplate, and system delta rows are skipped — re-extracting them would turn the cycle itself into memory. A **block digest** (name + curated description of the chat-scope memory blocks, riding in the user turn) tells the extraction model what existing blocks already cover so it doesn't duplicate it. Extraction no longer performs automatic block updates: memory blocks are agent-curated documents (written via the block tools), not an extraction side effect.

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

Mid-turn compaction has additional complexity because the agent is in the middle of a tool loop. The HTTP path (up to 5 cycles):

1. **Build progress summary** — captures the assistant's text output and tool calls so far
2. **Archive & flush** — standard compaction sequence (awaited); in-flight mid-turn extraction pulses are settled first so their cursor is final
3. **Rebuild system prompt** — `softResetMemoryContext()` retains the frozen section byte-exact; the recall delta is returned alongside it (see the delta-delivery note above)
4. **Fetch chat memories** — `getMemoriesFromChat(chatId, 10)` after flush, so newly extracted memories are included
5. **Assemble handoff message** — combines progress summary + memory delta + top-10 memories + "continue from where you left off"; persisted as a hidden `_isMidTurnCompaction` row so future replays see the exact token sequence the resumed call saw
6. **Resume via `agentLoopContinue`** — the handoff message is appended as a user message

The handoff message gives the resumed agent two things:
- **System prompt**: The retained frozen memories section + memory blocks + project context
- **Handoff message**: Explicit list of what was done, what tools were called, and key memories

This belt-and-suspenders approach ensures continuity even if the semantic retrieval misses something.

The hook is wired unconditionally on the HTTP path, but the removed-window filter in the flush is the effective gate: a chat whose rows are synthesis/automation/system plumbing extracts nothing.

**Headless mid-turn is the same skeleton with a leaner handoff.** `chat-turn-runner.ts` caps at 3 cycles, runs `truncateChatHistory` with `onBeforeArchive: undefined` (no flush — D4), and appends a minimal handoff built by `buildMidTurnHandoffText(removedCount)` — no progress summary, no memory fetch. Per turn-engine D6, the mid-turn unification is *shape-only*; content policy stays per-route.

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
  content='context_archives',
  content_rowid='rowid'
);
```

The FTS table is an external-content table kept in sync by `AFTER INSERT` / `AFTER DELETE` triggers on `context_archives`.

### Block Grouping

Messages are grouped into logical blocks before archiving:

- **User + visible assistant turn** → one block, including all consecutive `_toolLoopId` assistant fragments
- **Standalone visible assistant turn** → one block for all consecutive `_toolLoopId` assistant fragments
- **Legacy collapsed assistant-with-tools row** → one block
- **Standalone message** → one block

Split heads (partial-turn archive heads peeled off a kept message) carry the turn's final text, so archives — and the index generator and FTS — see the conclusions, not just reasoning traces and tool activity.

### Index Generation

Each block gets a one-line description, produced in one of two modes:

- **`sync`** (end-of-turn, mid-turn, `/compact`, hard-cap safety pass): the LLM (dedicated CPU extraction model, avoiding GPU contention) writes the description and blocks the compaction. Used where the summary may be consumed immediately, because the agent loop resumes right after.
- **`deferred`** (pre-send, the backstop): the archive is written immediately with a mechanical `generateFallbackDescription()` derived from truncated content previews, then `enrichArchiveDescriptions()` runs fire-and-forget in the background. It upgrades the archive rows *and* patches the persisted `_isCompactionSummary` message under the chat write lock (best-effort, 3 retries) so future contexts see the richer text. The point is to keep a user-facing request from ever waiting on a CPU model call — which matters less now that pre-send is a rare backstop than it did when it was the common path.

So on the pre-send path the summary the model actually sees in the immediately following turn is the *mechanical* one; the LLM description lands a moment later.

The index prompt focuses on:
- **What** the block contains (commands run, files read, decisions made)
- **Why** it might be useful later (retrieval cues for the agent)

### Agent Retrieval

Two tools access archived context:

1. **`read_archived_context(archive_id)`** — Retrieves full untruncated content of a specific archive block. The agent sees the archive ID in the compaction summary and can dereference it. Reasoning traces are omitted by default (`include_thinking: true` brings them back), output is rendered to fit the tool-result budget (per-field caps tighten in stages rather than hard-cutting the tail, where conclusions live), and large archives page via `offset`/`limit`.

2. **`search_conversation(query)`** — Searches both live messages and archive blocks via FTS5. Returns archive IDs with their index descriptions, prompting the agent to use `read_archived_context` for details.

## Key Design Decisions

### Why is pre-send a backstop rather than the primary path?

Pre-send compaction is waiting to compact until the user is at the keyboard, actively waiting for a response — bad UX. The end-of-turn check (0.80, conservative max of raw usage and refined estimate) therefore does the preemptive compaction in all foreseeable cases, while the user reads the response they just got. Pre-send stays at 0.85 purely as the safety net for what end-of-turn can't see: the next user message itself, rows appended after the check (recall deltas, queued follow-ups), skipped checks (`ask_user`, waiting-for-input, `/stop`, mid-turn exhaustion), and turns that never reported usage. Headless paths have no human waiting, so their pre-send stays cheap; D3 (automation end-of-turn) and D2 (synthesis/wake) both execute now, leaving D4 (headless flush) as the only open delta in this area.

### Why await instead of fire-and-forget?

Previous implementations used `.catch()` (fire-and-forget) for `preCompactionFlush`. This created a race condition: `buildSplitAugmentedPrompt` ran before the flush completed, so freshly extracted memories weren't in the store during retrieval. The system prompt would be rebuilt without the context that was just removed.

On the **HTTP paths**, awaiting the flush guarantees that the rebuilt system prompt includes memories extracted from the removed messages. The headless paths have not adopted this — the `onBeforeArchive` hook is `undefined` there, so the flush is skipped (see [design/turn-engine.md](design/turn-engine.md) delta D4).

### Why indexed summaries instead of narrative summaries?

The old approach (`generateCompactionSummary`, now removed) asked an LLM to write a paragraph summarizing removed messages. Problems:
- **Lossy**: Anything the summarizer chose not to include was lost
- **Unverifiable**: The agent couldn't check the original content
- **Single point of failure**: A bad summary meant permanent context loss

The indexed approach:
- **Lossless**: Full messages are always stored and retrievable
- **Verifiable**: The agent can `read_archived_context` to check original content
- **Multiple access paths**: Semantic search, FTS search, and direct ID reference

### Why does the flush continue the extraction session instead of building a standalone prompt?

The flush used to run its own system prompt (`PRE_COMPACTION_INSTRUCTIONS`). That prompt has been removed: the flush now appends the removed window as user turns on the chat's existing immediate-extraction session. Same system prompt means the same KV prefix, so the flush re-uses the warm cache from earlier pulses instead of re-prefilling on the shared extraction slot, and the `[PRE-COMPACTION]` framing plus the block digest live in the user turn to keep the prefix byte-stable across edits. (Related: automatic block updates from extraction — the old importance ≥ 7/≥ 8 thresholds — were removed entirely. Blocks are agent-curated; extraction only sees a digest of them to avoid duplicating covered knowledge.)

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
