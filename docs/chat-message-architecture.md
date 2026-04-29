# Chat Message Persistence Architecture

This document describes the current chat history architecture: paged message storage, canonical tool-loop persistence, replay compatibility, and client rendering.

## Goals

Recent long-running chats exposed two related problems:

- Large histories were expensive to load and render because the client received and cached whole chats.
- Tool-heavy assistant turns were persisted as one collapsed assistant row, even though the live LLM transcript was interleaved as assistant/tool-result iterations. That collapsed replay was functionally similar, but byte-different enough to destroy llama.cpp longest-common-prefix KV cache reuse on follow-up turns.

The current design fixes both while keeping the existing `Chat.messages` API shape usable during the compatibility window.

## Storage Model

Chat storage has three message-related layers:

- `chats.messages`: legacy JSON snapshot of the current `Chat.messages` array. It is still written by `saveChat()` for compatibility.
- `chat_message_rows`: full-fidelity row store keyed by `(chat_id, sequence)`. Each row stores the original `ChatMessage` in `payload_json` plus indexed metadata (`role`, `timestamp`, context flags). This is the preferred source when populated.
- `chat_messages` + `chat_messages_fts`: denormalized search projection for conversation FTS. This is not the full-fidelity message source.

`saveChat()` synchronizes the changed tail of `chat_message_rows` from the provided `Chat.messages` array. `getChat()` reads rows first and falls back to the legacy JSON snapshot if rows are absent or corrupt. Startup migration backfills rows from legacy JSON.

During the compatibility window, `sequence` is deliberately the absolute `Chat.messages` index. That keeps edit/retry, search jumps, compaction markers, and paged windows aligned.

## Message Windows

The API supports recent-window and older-window reads:

- `GET /api/chats/:id?messageLimit=200` returns the latest rows and attaches `messageOffset`, `messageTotal`, and `hasMoreMessages`.
- `GET /api/chats/:id/messages?before=<sequence>&limit=<n>` returns the window ending before an absolute sequence.
- The HTTP route and storage layer clamp `limit` to 1000.

The client requests the most recent 200 messages on chat selection, caches that window in IndexedDB, and loads older windows when the user scrolls near the top. `messageOffset` is added to local indexes before sending edit/retry calls, so server-side message indexes remain absolute.

## Canonical Tool-Loop Rows

The live pi-ai tool loop has this shape:

```text
assistant(thinking/text + tool call A)
toolResult A
assistant(thinking/text + tool call B)
toolResult B
assistant(final text)
```

Persistence now mirrors that transcript:

- Each `turn_end` with `stopReason === "toolUse"` is committed immediately as one assistant row.
- That row contains only the current iteration's `toolCalls`, matching `toolResults`, segments, thinking, artifacts, visuals, and generated images.
- Rows in one visible assistant response share `_toolLoopId`.
- Rows that end in a tool call carry `_toolLoopFragment: true`.
- The final assistant text is stored as a later assistant row with the same `_toolLoopId` and without `_toolLoopFragment`.

The server emits `message_complete` with `continues: true` after each persisted tool-use row. The client finalizes the current raw assistant row, clears streaming accumulators, and creates the next live assistant placeholder with the same `_toolLoopId`.

## Replay Semantics

`chatMessagesToPiMessages()` reconstructs persisted rows for the LLM:

- Canonical `_toolLoopFragment` rows reconstruct to one `AssistantMessage(stopReason:"toolUse")`, followed by the row's `ToolResultMessage[]`.
- The canonical final row reconstructs to `AssistantMessage(stopReason:"stop")`.
- Legacy collapsed rows still reconstruct through the old compatibility expansion: `AssistantMessage(toolUse)` -> `ToolResultMessage[]` -> `AssistantMessage(stop)`.

This matters for llama.cpp prompt caching. Follow-up turns need replay to be byte-compatible with the previous live loop. If all 20+ tool iterations are flattened into one assistant row, the prompt diverges at the first assistant token after the user message, causing an avoidable full prompt reprocess.

## Client Rendering

The client keeps the raw canonical rows in `messages` and IndexedDB. `ChatView` builds a display projection:

- Consecutive assistant rows with the same `_toolLoopId` are merged into one visible bubble.
- Content, thinking, segments, tool calls/results, artifacts, visuals, and generated images are concatenated for display.
- The raw `localStartIdx` is preserved for message indexes, and `localEndIdx` determines whether the merged bubble is the streaming tail.
- Streaming segment indexes are offset by the number of segments in earlier rows in the group.

This keeps the UI behavior close to the old single-bubble experience while preserving the canonical storage/replay shape underneath.

## Compatibility Rules

Keep these invariants when changing chat history code:

- Do not collapse `_toolLoopId` rows into a single persisted assistant message.
- Do not treat `chat_messages` as the source of truth; it is a search index.
- Preserve absolute sequence/index semantics until the `Chat.messages` compatibility snapshot is removed.
- Update both `server/src/types.ts` and `client/src/types.ts` when message metadata changes.
- For legacy rows with `toolCalls` and final `content`, keep the compatibility replay path.
- When persisting in-progress output, replace `_inProgress` rows rather than appending duplicates.
- For UI rendering, group split tool-loop rows visually but keep raw rows in state/cache.

## Future Work

The next structural step is to reduce reliance on the legacy `chats.messages` JSON snapshot. Once all callers can operate on row windows or explicit full-history reads, `saveChat()` can avoid rewriting the full chat JSON on every completion and update only the changed message rows plus metadata.
