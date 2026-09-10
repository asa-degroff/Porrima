# P0b — storage concurrency foundation (implementation plan)

**Status:** implemented 09-09 (PR1–PR4; PR5 docs), reviewed and hardened 09-10. Companion to [cross-chat-messaging.md](../cross-chat-messaging.md) v5, phase **P0b**. Tests: `server/src/__tests__/chat-storage-revision.test.ts` (26 cases) + `current-message.test.ts` (7 cases) plus the full server suite (714: 713 passing + 1 todo). Deferred: skipping no-op metadata-only saves only. Line numbers re-verified 09-10 00:5x against `git fe703ab` — the /stop fix renumbered `chat.ts` (by +6 to +213 depending on region) and touched `compaction.ts`, `system-chat.ts`, `automation-runner.ts`, `chat-turn-runner.ts`, `turn-compaction.ts`; the §5 audit below was re-derived from content at that commit. If `chat.ts` moves again, re-derive from the content anchors (the distinctive code quoted at each site), not the stale numbers.

## 1. Goal and invariant

**Invariant:** a writer may only rewrite the rows it loaded. Rows appended after it loaded are never its to delete.

Today `saveChat` synchronizes the full in-memory `chat.messages` array, and `syncChatMessageRows` deletes every row at `sequence >= firstChanged` before re-inserting from that array (`chat-storage.ts:1656-1699`). Any writer holding a snapshot that predates a concurrent append deletes it — including the collision case where the stale writer's own new row lands at the appended row's sequence. P0b replaces the length heuristic with per-chat optimistic concurrency, durable row identity, and a rebase in `saveChat`, plus an atomic append primitive for writers that have no in-memory array.

The identity part is load-bearing: **sequences are positions, not identities** (`chat-message-architecture.md` already says so), and the rebase renumbers preserved rows. Without a stable id, a third writer's claimed sequence can point at a different row after another writer's rebase — losing one row and duplicating another (`§3.2`). So P0b adds `row_id` alongside `revision`.

Deliverables:

1. `chats.revision` column + `Chat._baseRevision` transient.
2. `chat_message_rows.row_id` column + `ChatMessage._rowId` transient, with backfill and id-aware diffing.
3. `saveChat` rebase on revision mismatch (merge concurrent appends by row id, renumber, FTS).
4. `appendChatMessageRow(chatId, message)` — atomic append + revision bump + search sync.
5. Audit fixes at the call sites that need removal/replacement intent and at the route's "my message is last" assumptions (`§5`).
6. Tests (`§7`).

Non-goals: no cross-chat tooling, no UI, no migration off the legacy `chats.messages` mirror.

## 2. Data model

### 2.1 `chats.revision`

- `ALTER TABLE chats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0` using the existing PRAGMA pattern (`activeSkills` at `chat-storage.ts:381-384`).
- Bumped inside the same transaction as any row write to `chat_message_rows`: `UPDATE chats SET revision = revision + 1 WHERE id = ?`.
- Monotonic per chat; not compared across restarts. It is only a "did the rows change since I loaded?" signal.
- `createChat` writes `revision = 0` in its INSERT and stamps `chat._baseRevision = 0` on the caller's object.

Bump owners (all inside `withChatWriteLock` where runtime):

| Writer | Bump |
|---|---|
| `saveChat` sync + metadata UPDATE | yes, one transaction |
| `appendChatMessageRow` | yes |
| `createChat` | writes 0 |
| `getChat` legacy-JSON repair (`:608`, `:625`) | yes — wrap in the write lock and set the returned `_baseRevision` |
| startup backfill / search rebuild migrations | no (pre-serve; default 0) |
| manual repair scripts (`inline-image-payload-migration.ts`, `tool-result-image-payload-migration.ts`) | bump per touched chat and preserve `row_id`, or document "server stopped" |
| `updateChatMetadata`, `updateChatTitle`, `updateChatExtractionState` | no (no row writes) |
| `deleteChat` | irrelevant (rows deleted) |
| agent snapshot restore (`agent-snapshots.ts:197`) | restart required, or bump all after restore |

### 2.2 `chat_message_rows.row_id`

Stable per-row identity. Sequences stay positional during the compatibility window; ids survive renumbering, compaction re-splices, and rebase.

- `ALTER TABLE chat_message_rows ADD COLUMN row_id TEXT` (nullable — SQLite cannot add a NOT NULL column without a default). Backfill once, gated by a `storage_migrations` key `chat_message_rows_row_id_v1`: `UPDATE chat_message_rows SET row_id = chat_id || ':' || sequence WHERE row_id IS NULL`. The backfilled format is opaque; never parse it.
- After backfill: `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_rows_row_id ON chat_message_rows(chat_id, row_id)`.
- `ChatMessage._rowId?: string` (transient; stripped by `withoutTransientMessageMetadata`, server `types.ts` only — the client ignores unknown fields).
- Hydration: `loadChatMessageRows` and `getChatMessageWindow` read `row_id` and attach `_rowId` (next to `withRowIdentity`). `getChatMessageRange` reads the FTS projection, not payload rows, so it needs no change.
- Assignment: `syncChatMessageRows` and `appendChatMessageRow` generate `randomUUID()` for rows lacking an id and write it back onto the in-memory object (same pattern as `_rowSequence`).
- **The sync diff compares `row_id` as well as `payload_json`** (`chat-storage.ts:1649-1654`): an object whose id changed but content did not must be rewritten, or the DB keeps the old id and the next rebase sees a phantom duplicate.
- Claims and removals use ids: `claimedIds`, `removedRowIds`. `_rowSequence` remains positional, for UI/edit/retry, and is assigned densely on every save.
- Backstop: a loaded row without `_rowId` (pre-migration data while running) gets one generated; a DB row without `row_id` falls back to `(sequence, payload)` matching and is repaired on the next write. Unreachable after the startup backfill.

### 2.3 `Chat._baseRevision`

- Server `types.ts`: `_baseRevision?: number` on `Chat`.
- `getChat`, `getChatWithWindow`, and `updateChatMetadata` re-select hydration set it from the row.
- It leaks to clients through the four `routes/chats.ts` Chat responses (`:93`, `:99`, `:130`, `:155`). Accepted, matching the existing leak of `_rowSequence`; do not add it to client types.
- Set on the caller's object after every successful `saveChat`.

### 2.4 `_rowSequence` / `_rowId` assignment on save

`saveChat` (and `createChat`) assigns `_rowSequence` to every in-memory message after a successful sync, and ensures every message has a `_rowId`. Today `_rowSequence` is assigned only on load (`withRowSequence`, `chat-storage.ts:1541`), which means in-turn rows have no identity and in-place replacements silently orphan their DB row under rebase.

Consequences to protect:

- In-place replacements must carry identity forward: `upsertAssistantMessage` (`chat.ts:1495`), the crash-recovery replace at `chat.ts:4685-4690`, and any future `chat.messages[i] = ...`. Add `carryRowIdentity(next, previous)` copying `_rowId` and `_rowSequence`.
- Readers of `_rowSequence` become reliable after the first save: `chat.ts:3588-3600` (`firstKeptSequence` for client row dimming) and `chat.ts:4236-4249` (`assistantSequence` on the SSE done payload).
- The route's "the message I just pushed is last" assumptions are no longer true after an interleaved rebase (`§5.5`).

## 3. `saveChat` rebase

`saveChat(chat, opts?: { allowTruncation?: boolean; removedRowIds?: string[] })`.

Inside `withChatWriteLock` and the existing `db.transaction`:

1. Ensure identity: assign a `_rowId` to every in-memory message lacking one — new rows get one here too, and are identified in step 6 by *absence from the base*, not by lacking an id (step 1 pre-assigns to all, so "lacks an id" selects nothing). `_rowSequence` is assigned post-sync.
2. Read `current = SELECT revision FROM chats WHERE id = ?`.
3. If `chat._baseRevision === undefined` → legacy sync (no rebase) and log once at debug. Production loads set it; `createChat` sets it; only synthetic/test chats hit this.
4. If `chat._baseRevision === current` → existing `syncChatMessageRows` + `syncChatMessages`. No merge.
5. If `allowTruncation === true` → existing truncating sync. `removedRowIds` does not apply on this path (the sync already deletes at and after `firstChanged`).
6. Otherwise → **rebase**:
   - `claimedIds = { m._rowId | m in chat.messages }`.
   - `base` = DB rows ordered by sequence, selected with `sequence, row_id, payload_json`.
   - Emit a merged array in order:
     - For each DB row: if `row_id` ∈ `claimedIds`, emit the in-memory row with that id (the writer's version, content changes included); else if the payload has `_inProgress: true`, drop it (ephemeral cleanup, e.g. `chat.ts:4224`); else if `row_id` ∈ `removedRowIds`, drop it (e.g. `chat-turn-runner.ts:1050-1060` boundary discard); else preserve the stored payload (concurrent append).
     - In-memory rows whose `_rowId` is **not among the base DB row ids** are the writer's new rows: splice each after the emitted position of the nearest preceding in-memory row **that was emitted** (or at the head if none). **Successive id-less rows sharing an anchor are spliced in array order — the insertion position advances after each splice.** (A batch push like the streaming fragments at `chat-turn-runner.ts:597` must not come out reversed; read literally, "immediately after the anchor" would insert the second row between the anchor and the first.)
   - Replace `chat.messages` in place with the merged array, assign dense `_rowSequence` values (keep each `_rowId`), then run the existing `syncChatMessageRows` + `syncChatMessages` on it. The diff (now id-aware) finds `firstChanged` and rewrites only the changed tail.
   - Log at info: `[chat-storage] rebase chat=… baseRev=… currentRev=… preserved=… removed=… firstChanged=…`.
7. Bump revision, update `chat._baseRevision = current + 1`.

Guards:

- If the chat is a windowed snapshot (`chat.messageOffset !== undefined || chat.hasMoreMessages`), refuse the save and log loudly. The audit found no production `saveChat` call on a windowed chat; this guards future ones.
- `_baseRevision` mismatch with an empty `claimedIds` set is treated as "unloaded" — rebase still works (all DB rows preserved, in-memory rows appended), but log it.
- Two concurrent rewrite owners can still conflict on a claimed row; last writer wins within the lock. Rewrite owners (edit, compaction, archive enrichment) reload under the lock, so this is not expected in practice.

### 3.1 Why this algorithm

- It preserves concurrent appends regardless of whether the stale writer's array is shorter, equal, or longer than the DB.
- It handles compaction's mid-array summary splice (`compaction.ts:1208-1249`, splice at `1238`; same shape in `truncateChatHistory` at `2301-2343`, splice at `2334`): the summary is id-less and spliced after its anchor; claimed rows keep their identities; concurrent appends stay in the base order.
- It makes non-`allowTruncation` removals a no-op (preserve + warn) instead of silent data loss; intentional removals must be declared (`removedRowIds`, `_inProgress`, or `allowTruncation`).
- It reuses the existing sync on the merged array, so there is one row-writing implementation.

### 3.2 Why row_id is required (drift trace)

Without ids, claims are sequence values and break as soon as anyone renumbers:

1. Wake appends post P at seq N (revision bump); `runPromptAutomation` then `getChat`s and holds `[0..N-1, P@N]`.
2. A queued user turn U for the target saves pre-lease (`chat.ts:4946`): its rebase claims `{0..N-1}`, preserves P, inserts U after its anchor, dense-renumbers to **U@N, P@N+1**.
3. The wake saves: claimed `{0..N-1, N}`. The DB row at N is now U, but the wake's row claiming N is P. Sequence-claimed merge emits P at position N (dropping U) and preserves the stored P as unclaimed → **U lost, P duplicated**.

With `_rowId`, step 3 claims P by id, emits it at its current position, preserves U as an unclaimed committed row, and appends the wake's reply after P. Pinned in test 3c.

## 4. `appendChatMessageRow(chatId, message)`

```ts
export async function appendChatMessageRow(chatId: string, message: ChatMessage): Promise<ChatMessage>
```

- Inside `withChatWriteLock(chatId)` and a transaction:
  - `seq = SELECT COALESCE(MAX(sequence) + 1, 0) FROM chat_message_rows WHERE chat_id = ?`.
  - Ensure `message._rowId` (generate if absent); insert into `chat_message_rows` with the transient-stripped payload (`withoutTransientMessageMetadata`), the row id, search content (`buildSearchContent`), and indexed flags.
  - Search projection: insert into `chat_messages` (the FTS triggers handle `chat_messages_fts`). For assistant rows with `_toolLoopId`, extract the merge loop from `syncChatMessages` into `writeChatSearchRows` so the appended fragment merges into its group's document instead of creating a duplicate. Find the group start by scanning `chat_message_rows` payloads backwards from `seq - 1` while `_toolLoopId` matches, capped at `MAX_TOOL_LOOP_GROUP_SCAN = 600` (the HTTP loop's `MAX_ITERATIONS` is 500; headless budgets can reach 500) and log if the cap is hit.
  - `UPDATE chats SET revision = revision + 1, lastModified = ?`.
- Returns the message with `_rowSequence = seq` and `_rowId` assigned; it does **not** mutate a caller's `chat.messages`. Deliberate: an in-array caller that appended at `MAX+1` while its array has a gap would break the index-based sync. In-array writers stay on `saveChat`, now safe via rebase. Moving them to the append API is deferred until the array/index compatibility window narrows.
- Initial consumers: cross-chat post delivery and the post-turn passive-recall callback (`chat.ts:2228-2231`, which already reloads before appending). Both are array-less at the point of insert.
- `preview` is not recomputed; `lastModified` is enough for sidebar polling. Revisit only if the sidebar shows a stale preview for posts.

## 5. Call-site audit and required fixes

Classification of every `saveChat` site (full audit in the PR description; condensed here).

### 5.1 Rebase-safe as-is (append, mid-insert, content-only)

- Appends: `chat.ts:1664, 2231, 2357, 2406, 2443, 2617, 3039, 3185, 3342, 3432, 3567, 3710, 3810, 4034, 4148, 4224, 4316, 4347, 4360, 4535, 4589, 4690, 4770, 4946, 5342`; `system-chat.ts:943, 1293`; `automation-runner.ts:212, 256`; `chat-turn-runner.ts:466, 598, 653, 788, 986, 1060`; `user-images.ts:26-30` (content-only).
- Mid-insert memory deltas: `chat.ts:5106-5113, 5375-5381, 5765-5770` (new row, spliced immediately before the writer's own user row). Rebase-safe **only with an id-anchored splice**: the current positional `insertAt = messages.length - 1` is stale when the interleave lands before the user's own save — the rebase puts the preserved row at the tail, the splice then lands the delta *after* the user row, and the replay-merge invariant (`chat.ts:799-825`) merges it into the preserved row instead. The splice anchor is fixed in §5.5.
- Content-only: `chat.ts:4167, 4669, 4695`; `system-chat.ts:243-311`; `compaction.ts:1935`.
- Metadata-only (candidates to skip entirely in a later cleanup, not P0b): `chat.ts:2136, 2463, 4053, 4272`; `system-chat.ts:843`; `automation-runner.ts:104`.

### 5.2 Must declare removal intent (`removedRowIds`)

- `chat-turn-runner.ts:605-618` / final save `:1060` (discard call at `:1050`): `discardPersistedAssistantBoundaries` filters rows that were persisted earlier in the same turn (`:597-598`) and replaces them with a final aggregate. Collect their `_rowId`s before clearing `persistedAssistantBoundaries` (`:618`) and pass them to the final `saveChat`.
- `chat.ts:4222-4224`: pops a trailing `_inProgress` assistant. Covered by the `_inProgress` rule in the rebase, no explicit list needed. Verify the popped row was actually persisted before the save.

### 5.3 Must preserve identity on in-place replacement

- `chat.ts:1495` (`upsertAssistantMessage` replace branch): carry `_rowId`/`_rowSequence` from the replaced message.
- `chat.ts:4685-4690` (crash recovery replace-last): same.
- `chat.ts:4167, 4669, 4695` spread/copy existing objects and keep the fields; add tests to pin.

### 5.4 `allowTruncation` is the truncation marker (revised 09-10, Finding A)

**The plan's "stays log-only in P0b" claim was wrong as implemented:** `needsRebase` excludes `allowTruncation`, so the flag *disables the rebase* — a flagged save is array-authoritative and deletes what its array omits. That is correct only for writers that intentionally truncate. The five "add for intent clarity" sites were a live data-loss path the moment P1/P2 landed (a wake appends a post, then compacts the target with the flag → the post is deleted). Inventory after the 09-10 fix (content anchors; re-derive from them if the files move):

- **Keep it on — `/edit`'s truncation save, the only truncating write:** the save after "Truncate everything from targetIndex onwards", paired with `rejectOnRevisionConflict` (below). Nothing else may pass the flag.
- **Dropped from — compaction-then-save sites and `/edit`'s later saves (must rebase):** `chat.ts` mid-turn compaction (after the `midTurnFirstKeptSequence` capture), the `/compact` confirmation save (after `chat.messages.push(confirmMsg)`), resume pre-send (`preCompactionFlushHook(chat, "pre-send flush failed (resume)")`), send pre-send (`preCompactionFlushHook(chat, "pre-send flush failed")`); `system-chat.ts` synthesis + wake pre-compaction; `automation-runner.ts` pre-compaction (the P2 wake path — the site that made this urgent); `chat-turn-runner.ts` headless mid-turn compaction; `turn-compaction.ts` end-of-turn compaction; **and `/edit`'s pre-send-compaction save + memory-delta save** (09-10 follow-up). Compaction never removes rows, so these saves must preserve concurrent appends; an unflagged save combines with the id-resolved edited user row (`resolveCurrentMessageIndex`) so a concurrent append is preserved rather than turning a post-truncation save into a 409 (the pre-send save also runs after `ensureSSEStream`, where a 409 could not be written cleanly).

**`/edit` revision guard (spec commitment, implemented 09-10):** `saveChat` gains `rejectOnRevisionConflict` — checked under the write lock, before any write, independent of the rebase kill switch: if the stored revision moved past `chat._baseRevision`, throw `RevisionConflictError` (nothing written). The `/edit` route passes it only on its truncation save: a concurrent write since the load refuses the edit before anything is written (409, reload-and-retry) instead of the truncation deleting the concurrent append. Later saves in the route (pre-send compaction, memory delta) are unflagged and rebase, with the edited user row resolved by `resolveCurrentMessageIndex` — a concurrent append since the truncation survives, and a later rebase cannot resurrect the rows the truncation deleted (the walker drops seen-but-deleted rows). The old length guard (`chat.messages.length < dbRowCount`, 500) remains as the corruption backstop.

**Rebase: seen-but-deleted rows are dropped, not resurrected.** The walker distinguishes the writer's NEW rows (fresh ids, not in `loadedIds`) from rows it loaded but the DB no longer has (a concurrent truncating writer deleted them): the latter are dropped (`truncatedDropped` in the rebase log), honoring the truncating writer's intent. Without this, a queued turn rebasing after an `/edit` save would silently undo the truncation (the rows re-emit as "new"). Known boundary (documented in code): an id assigned by a same-process save that rolled back is indistinguishable from a loaded id; the effect is confined to ephemeral partials that were never persisted.

### 5.5 Route and reader fixes

- **Current-message tracking (send route):** after pushing the user row and saving (`chat.ts:4938`/`:4946`), capture its `_rowId` and resolve `currentUserIndex` (`chat.ts:5122-5125`) and `trailingRow`/`sendTimeAnchor` (`:5184-5186`) by that id, not by `messages.length - 1`. After an interleaved rebase the writer's message is no longer last, and the current code would treat the other request's row as the current prompt (wrong context split and time anchor). **Implemented 09-10:** the resolution lives in `services/current-message.ts` (`resolveCurrentMessageIndex`/`resolveTrailingRow`, pure) and is used by the send route; pinned by `current-message.test.ts` (test 11) against the interleaved shape, including the delta-adjacency invariant under both interleave timings. The resume (ask_user answer) branch was re-verified 09-10 to be **outside** the F1 consumer set: it ends in its own `handleChatStream` with `userPiMessage=null` and a `pendingState`-built context, with no positional current-message resolution after its push — the review's "set `currentUserRow` on resume" one-liner would be dead code and was not applied (if the resume path is ever merged into the shared tail, the id-tracking must extend with it). The dedup branch is safe as-is: it pushes no row, so no rebase can move "our row" (the tail fallback is its intended behavior). **Repair route fixed 09-10 (follow-up):** it now captures the pushed repair row and resolves `currentPromptIndex` and its memory-delta splice through `resolveCurrentMessageIndex`; `/edit` tracks its edited user row the same way. No positional current-message consumers remain (the resume branch was already outside the set).
- **Memory-delta splice anchor:** the three delta splices (`chat.ts:5107, 5375, 5765`) must anchor on the captured user row's `_rowId` — inserted immediately before it — not at `messages.length - 1`. When the interleave lands before the user's own save, the rebase puts the preserved row at the tail and the positional splice lands the delta *after* the user row; the replay-merge invariant then targets the preserved row while the live turn answers the user row — a live/replay divergence. Id-anchored, the order stays `[origins, delta, user, post]` under either interleave timing.
- **Audit residual `length - 1` assumptions** (closed 09-10): no positional CURRENT-MESSAGE consumers remain — send, repair, and edit all resolve their current row by `_rowId`; the resume branch was never in the set. Sibling assumption class, "last is the in-progress placeholder": the NO-CONTENT cleanup pop (the `lastMsg._inProgress` tail check) and the crash-recovery tail check can be hijacked by a concurrent append landing after the placeholder (a cross-chat post during the turn); recovery already mitigates its dangerous branch with an identity-based scan. Named residual: the NO-CONTENT pop should scan backward for the `_inProgress` assistant row instead of reading only the tail — otherwise the placeholder persists as a committed row.
- **Row-dimming event:** `chat.ts:3588-3600` reads `_rowSequence` and assumes no renumbering. Recompute after the save that triggered it, or read the merged values.
- **Done payload:** `chat.ts:4236-4249` should take `assistantSequence` from the persisted message's `_rowSequence` once `saveChat` assigns it.

## 6. Edge cases and decisions

- **Ephemeral rows:** unclaimed DB rows with `_inProgress: true` are dropped by rebase. Only the owning turn persists in-progress rows, so no concurrent writer's data is at risk.
- **Legacy fallback:** `_baseRevision === undefined` keeps the old behavior. `createChat` and all `getChat` paths set it; the only known undefined case is `storage-diagnostics.test.ts:60-62` and similar synthetic chats.
- **Revision regression after snapshot restore:** `agent-snapshots.ts` replaces the DB wholesale; require a restart after restore (or bump every revision). Document in the restore path.
- **Windows:** `getChatWithWindow` results must never be saved; guard in `saveChat`.
- **Concurrent rewrites:** out of scope beyond "last writer wins on a claimed row id". Rewrite owners reload under the lock; if two rewrites interleave, log the mismatch and preserve unclaimed rows.
- **Queued-message ordering (accepted wart):** if two writers interleave so both load before either saves, the later writer's rebase places its own message before the earlier-committed one (anchor splice, not commit order). No data loss — both persist, including through a third writer's later rebase (`§3.2`), a strict improvement over today's silent deletion. If it surfaces, refine to a timestamp-ordered splice (rows carry `timestamp`). The route-side consequence is handled by `§5.5`.
- **Replay shape in the wart:** the order means a reply generated before the other message can be persisted after it, so that row's replay is not byte-identical to its live prompt. This is inherent to interleaving (no ordering preserves both prompts); accepted and logged, not "fixed". The compatibility-window invariant applies to normal turns, not to this anomaly.
- **Kill switch:** `PORRIMA_STORAGE_REBASE=0` falls back to the legacy sync (for one release). Default on.
- **Performance:** rebase is O(chat length) and only runs on revision mismatch (rare). Append is one indexed `MAX` + insert. The `row_id` backfill is a one-time O(rows) UPDATE.

## 7. Tests

Harness: the `loadChatStorage(homeDir)` pattern in `chat-storage.test.ts` (fresh `homedir`, `vi.resetModules`, real SQLite). New file `server/src/__tests__/chat-storage-revision.test.ts` unless noted.

1. **Plumbing:** `createChat` → `getChat`/`getChatWithWindow` expose `_baseRevision` and `_rowId`; every row backfills a `row_id`; `appendChatMessageRow` and `saveChat` bump the stored revision and the returned base.
2. **Append API:** appends at `MAX+1`, assigns `_rowSequence` and `_rowId`, strips transient fields, indexes `chat_messages` (query via `searchChatMessages`), bumps `lastModified`.
3. **Collision (core):** load B at N rows; call `appendChatMessageRow` on B (simulating source-turn post at sequence N); append B's own new row to the loaded array and `saveChat`. Assert: post survives, B's row is spliced after its anchor (before the preserved post, per the anchor-splice rule), `_rowSequence`s are dense and updated, no duplication.
   3b. **Two queued writers (accepted wart, §6):** B1 and B2 both load at N rows; B1 saves; B2 saves. Assert **both** persist (no loss), order pinned as user2 before user1, and `_rowId`s unchanged by the renumber.
   3c. **Renumber drift (row_id core, `§3.2`):** wake appends P at N; a queued writer's rebase renumbers P to N+1; the wake saves its pre-rebase snapshot. Assert the queued writer's row survives, P appears exactly once, and dense sequences are consistent.
4. **Mid-array rebase:** loaded chat; concurrent append; then compaction-style mutation (mark rows `_outOfContext`, splice a summary at an interior index) and `saveChat`. Assert both the summary order and the concurrent append. Sub-cases: (a) a memory-delta-style splice — a new id-less row inserted before the writer's just-pushed, still id-less user row (`chat.ts:5106-5113` pattern) — keeps the splice adjacent to its anchor: assert the exact order `[origins, delta, user, post]`, not just survival (the replay-merge invariant at `chat.ts:799-825`) — **under both interleave timings**, including the interleave that lands before the user's own save, where the splice must anchor on the user row's `_rowId` (immediately before it), not `messages.length - 1`; (b) a batch push of ≥2 id-less rows (streaming-fragment shape, `chat-turn-runner.ts:597`) plus a concurrent append keeps the batch in array order — no reversal, dense renumbering.
5. **Match path:** save with matching revision rewrites nothing beyond the changed tail (compare `payload_json` and `row_id` before/after for unchanged rows).
6. **Targeted removal:** persist boundary rows, filter them, save with `removedRowIds`; a concurrent append survives; only the declared rows are gone.
7. **Ephemeral row:** unclaimed `_inProgress` row is dropped; unclaimed committed row is preserved.
8. **Identity carry:** replace an in-progress row via the `upsertAssistantMessage` shape and assert no duplicate is created on a rebase.
9. **Truncation guarded:** `/edit`-style `allowTruncation: true` still deletes from the target down on a matching revision (unchanged). New 09-10: with `rejectOnRevisionConflict` and a moved revision, `saveChat` throws `RevisionConflictError` and writes nothing — the concurrent append stays intact, the revision is unchanged.
10. **Window guard:** `saveChat` on a `getChatWithWindow` result refuses.
11. **Route current-message tracking (implemented 09-10, `current-message.test.ts`):** the interleaved array ([origins, user, post]) resolves `currentUserIndex`/`trailingRow` from the captured id, not the tail; the memory-delta splice lands immediately before the user row under both interleave timings (replay-merge invariant); tail fallback when no row is tracked or the tracked row left the array; the repair route's pushed system row resolves the same way (delta adjacent, preserved append at the tail).
12. **Truncation interleave (new 09-10):** a queued turn loads the full thread; `/edit` truncates and saves; the queued turn saves (rebases). Assert the truncated rows are NOT resurrected, the queued row and the edited row both survive, sequences dense, ids unique. Also (09-10 follow-up, 8e3fdda): `/edit`'s later saves rebase around a concurrent append with the delta id-anchored — `[u1, a1, delta, u2 (edited), concurrent post]`, unique ids.
13. **Regression suite:** `chat-storage.test.ts`, `storage-diagnostics.test.ts`, `delayed-extraction-scheduler.test.ts`, `compaction-safety.test.ts`, `compaction-retention.test.ts`, `compaction-forensics.test.ts`, `turn-compaction.test.ts`, `chat-turn-runner.test.ts`, `tool-result-persistence.test.ts`, `tool-result-wire-replay-shape.test.ts`, `memory-context-persistence.test.ts`.

## 8. PR breakdown

- **PR1 — identity plumbing (no behavior change):** `revision` + `row_id` schema/backfill/unique index, `Chat._baseRevision`, `ChatMessage._rowId`, hydration, id-aware sync insert/diff, `createChat`, repair path lock/bump, tests 1, 10, and the `row_id` assertions across the suite. Lowest risk; independently reviewable.
- **PR2 — rebase:** `mergeConcurrentAppends` (by id), `saveChat` branch, assignment of `_rowSequence`/`_rowId` on save, logging, kill switch, tests 3, 3b, 3c, 4, 5, 7, 9.
- **PR3 — append API:** `appendChatMessageRow`, `writeChatSearchRows` extraction, tests 2 and 4's FTS assertions.
- **PR4 — audit + route fixes:** `removedRowIds` plumbing, identity carry, `chat.ts:3588`/`:4236`, send-route current-message tracking, memory-delta splice anchors, and residual `length - 1` audit, tests 4(a), 6, 8, 11.
- **PR5 — docs + cleanup:** storage-architecture note, optional skip of no-op metadata saves.

Each PR: `cd server && npx tsc --noEmit && npm test`.

## 9. Risks

- Rebase touches the core write invariant; the kill switch and the regression suite are the mitigations.
- `row_id` is an additive column with a one-time backfill and a unique index; restore/migration scripts must preserve it.
- `_rowSequence`/`_rowId` assignment on save changes transient fields some paths read; tests 3, 5, and the `§5.5` fixes cover it.
- `chats.revision` writes add one UPDATE per save; negligible against the existing row sync.
- The `_baseRevision` leak to clients is cosmetic and matches `_rowSequence`.
